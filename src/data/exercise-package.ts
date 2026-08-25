import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { rejectSymlinkComponents, resolveContained } from "../adapters/paths.ts";
import { digestJson, sha256 } from "../core/canonical.ts";
import { datasetCaseSchema, datasetSchema, generationResponseSchema } from "../contracts.ts";
import {
  referenceSetDigest,
  referenceSetSchema,
  validateAndDigestReferenceBundle,
} from "./reference-set.ts";

export const EXERCISE_PACKAGE_SCHEMA_VERSION = "1" as const;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, '.', '_' or '-'");

export const exercisePackageCaseSchema = datasetCaseSchema.safeExtend({
  family_id: identifier.optional(),
  bundle: z.string().min(1),
  annotations: z.string().min(1).optional(),
});

export const exercisePackageSchema = z
  .object({
    schema_version: z.literal(EXERCISE_PACKAGE_SCHEMA_VERSION),
    id: identifier,
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    cases: z.array(exercisePackageCaseSchema).min(1),
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "exercise package case IDs must be unique",
      });
    }
  });

export type ExercisePackage = z.infer<typeof exercisePackageSchema>;

export interface LoadedExercisePackageCase {
  manifest: ExercisePackage["cases"][number];
  familyId: string;
  briefPath: string;
  brief: string;
  briefSha256: string;
  bundlePath: string;
  bundleDigest: string;
  annotationPath?: string;
  annotationSha256?: string;
}

export interface LoadedExercisePackage {
  manifest: ExercisePackage;
  manifestPath: string;
  directory: string;
  cases: LoadedExercisePackageCase[];
  digest: string;
}

async function readStructuredFile(path: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(source) : parse(source);
}

async function resolvePackageFile(
  directory: string,
  candidate: string,
  subject: string,
): Promise<string> {
  const path = resolveContained(directory, candidate, subject);
  await rejectSymlinkComponents(directory, path, subject);
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error(`${subject} must be a regular file: ${candidate}`);
  }
  return path;
}

async function resolvePackageDirectory(
  directory: string,
  candidate: string,
  subject: string,
): Promise<string> {
  const path = resolveContained(directory, candidate, subject);
  await rejectSymlinkComponents(directory, path, subject);
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`${subject} must be a directory: ${candidate}`);
  }
  return path;
}

export async function loadExercisePackage(pathInput: string): Promise<LoadedExercisePackage> {
  const manifestPath = resolve(pathInput);
  const directory = dirname(manifestPath);
  const manifest = exercisePackageSchema.parse(await readStructuredFile(manifestPath));
  const cases = await Promise.all(
    manifest.cases.map(async (item): Promise<LoadedExercisePackageCase> => {
      const briefPath = await resolvePackageFile(directory, item.brief, "exercise package brief");
      const brief = await readFile(briefPath, "utf8");
      if (brief.trim().length === 0) {
        throw new Error(`exercise package brief is empty: ${item.brief}`);
      }
      const bundlePath = await resolvePackageDirectory(
        directory,
        item.bundle,
        "exercise package bundle",
      );
      const { bundleDigest } = await validateAndDigestReferenceBundle(
        bundlePath,
        `reference bundle for ${item.id}`,
      );
      let annotationPath: string | undefined;
      let annotationSha256: string | undefined;
      if (item.annotations !== undefined) {
        annotationPath = await resolvePackageFile(
          directory,
          item.annotations,
          "exercise package annotation",
        );
        annotationSha256 = sha256(await readFile(annotationPath));
      }
      return {
        manifest: item,
        familyId: item.family_id ?? item.id,
        briefPath,
        brief,
        briefSha256: sha256(brief),
        bundlePath,
        bundleDigest,
        ...(annotationPath === undefined ? {} : { annotationPath }),
        ...(annotationSha256 === undefined ? {} : { annotationSha256 }),
      };
    }),
  );
  const digest = digestJson({
    manifest,
    cases: cases.map((item) => ({
      id: item.manifest.id,
      family_id: item.familyId,
      brief_sha256: item.briefSha256,
      bundle_digest: item.bundleDigest,
      annotation_sha256: item.annotationSha256 ?? null,
    })),
  });
  return { manifest, manifestPath, directory, cases, digest };
}

async function copyTree(source: string, target: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`exercise package contains a symbolic link: ${source}`);
  }
  if (metadata.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, metadata.mode & 0o777);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`exercise package entry is neither a file nor directory: ${source}`);
  }
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source)).sort()) {
    await copyTree(join(source, entry), join(target, entry));
  }
}

export interface MaterializedExercisePackage {
  directory: string;
  datasetPath: string;
  referenceSetPath: string;
  packageDigest: string;
  cases: number;
}

async function copyReferenceBundle(
  source: string,
  target: string,
  response: z.infer<typeof generationResponseSchema>,
): Promise<void> {
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "response.json"), `${JSON.stringify(response, null, 2)}\n`, "utf8");
  for (const artifact of response.artifacts) {
    const artifactSource = resolveContained(source, artifact.path, "reference artifact");
    await rejectSymlinkComponents(source, artifactSource, "reference artifact");
    await copyTree(artifactSource, join(target, artifact.path));
  }
}

export async function materializeExercisePackage(
  loaded: LoadedExercisePackage,
  outputInput: string,
): Promise<MaterializedExercisePackage> {
  const output = resolve(outputInput);
  try {
    await lstat(output);
    throw new Error(`materialization output already exists: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(output)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    const datasetCases = [];
    const lockCases = [];
    const referenceCases = [];
    for (const item of loaded.cases) {
      const caseId = item.manifest.id;
      const briefRelative = `briefs/${caseId}.md`;
      await mkdir(join(temporary, "briefs"), { recursive: true });
      await writeFile(join(temporary, briefRelative), item.brief, "utf8");
      const response = generationResponseSchema.parse(
        JSON.parse(await readFile(join(item.bundlePath, "response.json"), "utf8")),
      );
      const referenceBundleRelative = `reference-bundles/${caseId}`;
      await copyReferenceBundle(
        item.bundlePath,
        join(temporary, referenceBundleRelative),
        response,
      );
      const {
        family_id: _familyId,
        bundle: _bundle,
        annotations: _annotations,
        ...datasetCase
      } = item.manifest;
      datasetCases.push({
        ...datasetCase,
        brief: `./${briefRelative}`,
        extensions: {
          ...(datasetCase.extensions ?? {}),
          case_family: item.familyId,
        },
      });
      lockCases.push({
        id: caseId,
        family_id: item.familyId,
        brief_sha256: item.briefSha256,
        bundle_digest: item.bundleDigest,
        annotation_sha256: item.annotationSha256 ?? null,
      });
      referenceCases.push({
        id: caseId,
        family_id: item.familyId,
        bundle: `./${referenceBundleRelative}`,
        bundle_digest: item.bundleDigest,
      });
    }
    const dataset = datasetSchema.parse({
      schema_version: "2",
      id: loaded.manifest.id,
      version: loaded.manifest.version,
      title: loaded.manifest.title,
      description: loaded.manifest.description,
      license: loaded.manifest.license,
      cases: datasetCases,
      extensions: {
        ...loaded.manifest.extensions,
        exercise_package_schema_version: loaded.manifest.schema_version,
        exercise_package_digest: loaded.digest,
      },
    });
    await writeFile(join(temporary, "dataset.yaml"), stringify(dataset), "utf8");
    const referenceSetContent = {
      schema_version: "1" as const,
      package: {
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        digest: loaded.digest,
      },
      cases: referenceCases,
    };
    const referenceSet = referenceSetSchema.parse({
      ...referenceSetContent,
      digest: referenceSetDigest(referenceSetContent),
    });
    await writeFile(join(temporary, "reference-set.yaml"), stringify(referenceSet), "utf8");
    await writeFile(
      join(temporary, "package-lock.json"),
      `${JSON.stringify(
        {
          schema_version: "1",
          package: {
            id: loaded.manifest.id,
            version: loaded.manifest.version,
            digest: loaded.digest,
          },
          cases: lockCases,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(temporary, "catalog.json"),
      `${JSON.stringify(
        {
          package: {
            id: loaded.manifest.id,
            version: loaded.manifest.version,
            title: loaded.manifest.title,
          },
          cases: loaded.cases.map((item) => ({
            id: item.manifest.id,
            family_id: item.familyId,
            title: item.manifest.title,
            tags: item.manifest.tags,
            brief: `briefs/${item.manifest.id}.md`,
            reference_bundle: `reference-bundles/${item.manifest.id}`,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    directory: output,
    datasetPath: join(output, "dataset.yaml"),
    referenceSetPath: join(output, "reference-set.yaml"),
    packageDigest: loaded.digest,
    cases: loaded.cases.length,
  };
}
