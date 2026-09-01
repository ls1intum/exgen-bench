import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { rejectSymlinkComponents, resolveContained } from "../adapters/paths.ts";
import { datasetCaseSchema, datasetSchema } from "../contracts.ts";
import { digestJson, sha256 } from "../core/canonical.ts";
import { readBytesBounded, readTextBounded } from "../core/files.ts";
import { conditional } from "../json-schema.ts";
import {
  referenceSetDigest,
  referenceSetSchema,
  snapshotReferenceBundle,
  validateAndDigestReferenceBundle,
} from "./reference-set.ts";

export const EXERCISE_PACKAGE_SCHEMA_VERSION = "1" as const;
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BRIEF_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ANNOTATION_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SOURCE_ENTRIES = 100_000;
const MAXIMUM_SOURCE_BYTES = 1024 * 1024 * 1024;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, '.', '_' or '-'");

export const exercisePackageCaseSchema = datasetCaseSchema.safeExtend({
  family_id: identifier.optional(),
  bundle: z.string().min(1).optional(),
  annotations: z.string().min(1).optional(),
  sources: z
    .array(
      z.strictObject({
        role: identifier,
        path: z.string().min(1),
      }),
    )
    .default([]),
});

export const exercisePackageSchema = z
  .object({
    schema_version: z.literal(EXERCISE_PACKAGE_SCHEMA_VERSION),
    status: z.enum(["wip", "ready"]),
    id: identifier,
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    cases: z.array(exercisePackageCaseSchema).min(1).max(10_000),
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
    if (value.status === "ready") {
      for (const [index, item] of value.cases.entries()) {
        if (item.bundle === undefined) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "bundle"],
            message: "ready exercise packages require a complete bundle for every case",
          });
        }
      }
    }
    for (const [index, item] of value.cases.entries()) {
      if (item.extensions?.case_family !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "extensions", "case_family"],
          message: "case_family is reserved; use family_id",
        });
      }
    }
  })
  .meta({
    allOf: [
      conditional(
        {
          properties: { status: { const: "ready" } },
          required: ["status"],
        },
        {
          properties: {
            cases: { items: { required: ["bundle"] } },
          },
        },
      ),
    ],
  });

export type ExercisePackage = z.infer<typeof exercisePackageSchema>;

export interface LoadedExercisePackageCase {
  manifest: ExercisePackage["cases"][number];
  familyId: string;
  briefPath: string;
  brief: string;
  briefSha256: string;
  bundlePath?: string;
  bundleDigest?: string;
  annotationSha256?: string;
  sources: Array<{
    role: string;
    path: string;
    digest: string;
  }>;
}

export interface LoadedExercisePackage {
  manifest: ExercisePackage;
  cases: LoadedExercisePackageCase[];
  digest: string;
}

async function readStructuredFile(path: string): Promise<unknown> {
  const source = await readTextBounded(path, MAXIMUM_MANIFEST_BYTES, { rejectHardLinks: true });
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

async function digestPackageSource(
  path: string,
  budget: { entries: number; bytes: number },
): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (current: string): Promise<void> => {
    budget.entries += 1;
    if (budget.entries > MAXIMUM_SOURCE_ENTRIES) {
      throw new Error(`package sources exceed ${MAXIMUM_SOURCE_ENTRIES} entries`);
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink())
      throw new Error(`package source contains a symbolic link: ${current}`);
    const entryPath = relative(path, current).split(sep).join("/") || ".";
    if (metadata.isFile()) {
      if (metadata.nlink > 1) throw new Error(`package source contains a hard link: ${current}`);
      budget.bytes += metadata.size;
      if (budget.bytes > MAXIMUM_SOURCE_BYTES) {
        throw new Error(`package sources exceed ${MAXIMUM_SOURCE_BYTES} bytes`);
      }
      entries.push({
        path: entryPath,
        type: "file",
        mode: metadata.mode & 0o777,
        size: metadata.size,
        sha256: sha256(await readBytesBounded(current, metadata.size, { rejectHardLinks: true })),
      });
      return;
    }
    if (!metadata.isDirectory()) throw new Error(`unsupported package source entry: ${current}`);
    entries.push({ path: entryPath, type: "directory" });
    for (const entry of (await readdir(current)).sort()) await walk(join(current, entry));
  };
  await walk(path);
  return digestJson(entries);
}

export async function loadExercisePackage(pathInput: string): Promise<LoadedExercisePackage> {
  const manifestPath = resolve(pathInput);
  const directory = dirname(manifestPath);
  const manifest = exercisePackageSchema.parse(await readStructuredFile(manifestPath));
  const sourceBudget = { entries: 0, bytes: 0 };
  const cases: LoadedExercisePackageCase[] = [];
  for (const item of manifest.cases) {
    const briefPath = await resolvePackageFile(directory, item.brief, "exercise package brief");
    const brief = await readTextBounded(briefPath, MAXIMUM_BRIEF_BYTES, {
      rejectHardLinks: true,
    });
    if (brief.trim().length === 0) {
      throw new Error(`exercise package brief is empty: ${item.brief}`);
    }
    let bundlePath: string | undefined;
    let bundleDigest: string | undefined;
    if (item.bundle !== undefined) {
      bundlePath = await resolvePackageDirectory(directory, item.bundle, "exercise package bundle");
      ({ bundleDigest } = await validateAndDigestReferenceBundle(
        bundlePath,
        `reference bundle for ${item.id}`,
      ));
    }
    let annotationSha256: string | undefined;
    if (item.annotations !== undefined) {
      const annotationPath = await resolvePackageFile(
        directory,
        item.annotations,
        "exercise package annotation",
      );
      annotationSha256 = sha256(
        await readBytesBounded(annotationPath, MAXIMUM_ANNOTATION_BYTES, {
          rejectHardLinks: true,
        }),
      );
    }
    const sources: LoadedExercisePackageCase["sources"] = [];
    for (const source of item.sources) {
      const path = resolveContained(directory, source.path, "exercise package source");
      await rejectSymlinkComponents(directory, path, "exercise package source");
      sources.push({
        role: source.role,
        path: source.path,
        digest: await digestPackageSource(path, sourceBudget),
      });
    }
    cases.push({
      manifest: item,
      familyId: item.family_id ?? item.id,
      briefPath,
      brief,
      briefSha256: sha256(brief),
      ...(bundlePath === undefined ? {} : { bundlePath }),
      ...(bundleDigest === undefined ? {} : { bundleDigest }),
      ...(annotationSha256 === undefined ? {} : { annotationSha256 }),
      sources,
    });
  }
  const digest = digestJson({
    manifest,
    cases: cases.map((item) => ({
      id: item.manifest.id,
      family_id: item.familyId,
      brief_sha256: item.briefSha256,
      bundle_digest: item.bundleDigest ?? null,
      annotation_sha256: item.annotationSha256 ?? null,
      source_digests: item.sources.map((source) => ({
        role: source.role,
        path: source.path,
        digest: source.digest,
      })),
    })),
  });
  return { manifest, cases, digest };
}

export interface MaterializedExercisePackage {
  directory: string;
  datasetPath: string;
  referenceSetPath: string;
  packageDigest: string;
  cases: number;
}

export async function materializeExercisePackage(
  loaded: LoadedExercisePackage,
  outputInput: string,
  caseIds?: string[],
): Promise<MaterializedExercisePackage> {
  if (loaded.manifest.status !== "ready") {
    throw new Error(`cannot materialize WIP exercise package ${loaded.manifest.id}`);
  }
  const selectedIds = caseIds === undefined ? undefined : new Set(caseIds);
  if (selectedIds?.size === 0) throw new Error("at least one case must be selected");
  if (selectedIds !== undefined && selectedIds.size !== caseIds?.length) {
    throw new Error("selected case IDs must be unique");
  }
  const unknownIds = [...(selectedIds ?? [])].filter(
    (caseId) => !loaded.cases.some((item) => item.manifest.id === caseId),
  );
  if (unknownIds.length > 0) throw new Error(`unknown package case IDs: ${unknownIds.join(", ")}`);
  const selectedCases =
    selectedIds === undefined
      ? loaded.cases
      : loaded.cases.filter((item) => selectedIds.has(item.manifest.id));
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
    const referenceCases = [];
    for (const item of selectedCases) {
      if (item.bundlePath === undefined || item.bundleDigest === undefined) {
        throw new Error(`ready exercise package case ${item.manifest.id} has no bundle`);
      }
      const caseId = item.manifest.id;
      const briefRelative = `briefs/${caseId}.md`;
      await mkdir(join(temporary, "briefs"), { recursive: true });
      await writeFile(join(temporary, briefRelative), item.brief, "utf8");
      const referenceBundleRelative = `reference-bundles/${caseId}`;
      const copied = await snapshotReferenceBundle(
        item.bundlePath,
        join(temporary, referenceBundleRelative),
        `materialized reference bundle for ${caseId}`,
      );
      if (copied.bundleDigest !== item.bundleDigest) {
        throw new Error(`reference bundle changed while materializing case ${caseId}`);
      }
      const {
        family_id: _familyId,
        bundle: _bundle,
        annotations: _annotations,
        sources: _sources,
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
      referenceCases.push({
        id: caseId,
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
      extensions:
        selectedIds === undefined
          ? loaded.manifest.extensions
          : {
              ...loaded.manifest.extensions,
              exercise_package_selection: selectedCases.map((item) => item.manifest.id),
            },
    });
    await writeFile(join(temporary, "dataset.yaml"), stringify(dataset), "utf8");
    const referenceSetContent = {
      schema_version: "1" as const,
      package: {
        id: loaded.manifest.id,
        version: loaded.manifest.version,
      },
      cases: referenceCases,
    };
    const referenceSet = referenceSetSchema.parse({
      ...referenceSetContent,
      digest: referenceSetDigest(referenceSetContent),
    });
    await writeFile(join(temporary, "reference-set.yaml"), stringify(referenceSet), "utf8");
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
    cases: selectedCases.length,
  };
}
