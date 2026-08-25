import { chmod, copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { validateAndDigestArtifacts } from "../adapters/artifacts.ts";
import { rejectSymlinkComponents, resolveContained } from "../adapters/paths.ts";
import { digestJson } from "../core/canonical.ts";
import { readTextBounded } from "../core/files.ts";
import { generationResponseSchema } from "../contracts.ts";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, '.', '_' or '-'");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;

const referenceSetContentSchema = z.strictObject({
  schema_version: z.literal("1"),
  package: z.strictObject({
    id: identifier,
    version: z.string().min(1),
  }),
  cases: z
    .array(
      z.strictObject({
        id: identifier,
        bundle: z.string().min(1),
        bundle_digest: digest,
      }),
    )
    .min(1)
    .max(10_000),
});

export const referenceSetSchema = referenceSetContentSchema
  .safeExtend({ digest })
  .superRefine((value, context) => {
    const ids = value.cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "reference-set case IDs must be unique",
      });
    }
  });

export type ReferenceSet = z.infer<typeof referenceSetSchema>;

export function referenceSetDigest(
  referenceSet: Pick<ReferenceSet, "schema_version" | "package" | "cases">,
): string {
  return digestJson({
    schema_version: referenceSet.schema_version,
    package: referenceSet.package,
    cases: referenceSet.cases,
  });
}

function validateReferenceResponse(
  response: z.infer<typeof generationResponseSchema>,
  subject: string,
): void {
  if (response.status !== "succeeded") {
    throw new Error(`${subject} must have status succeeded`);
  }
  if (response.diagnostics.length > 0) {
    throw new Error(`${subject} must not contain run diagnostics`);
  }
  const artifactPaths = response.artifacts.map((artifact) => artifact.path.replace(/\/$/, ""));
  for (const [index, path] of artifactPaths.entries()) {
    if (posix.normalize(path) !== path) {
      throw new Error(`${subject} uses non-canonical artifact path ${path}`);
    }
    if (path === "." || path === "response.json" || path.startsWith("response.json/")) {
      throw new Error(`${subject} uses reserved artifact path ${path}`);
    }
    for (const other of artifactPaths.slice(index + 1)) {
      if (path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) {
        throw new Error(`${subject} has overlapping artifact paths ${path} and ${other}`);
      }
    }
  }
}

export async function validateAndDigestReferenceBundle(
  bundlePath: string,
  subject: string,
): Promise<{ response: z.infer<typeof generationResponseSchema>; bundleDigest: string }> {
  const response = generationResponseSchema.parse(
    JSON.parse(
      await readTextBounded(join(bundlePath, "response.json"), MAXIMUM_MANIFEST_BYTES, {
        rejectHardLinks: true,
      }),
    ),
  );
  validateReferenceResponse(response, subject);
  const artifactDigest = await validateAndDigestArtifacts(response, bundlePath);
  if (artifactDigest === undefined) {
    throw new Error(`${subject} declares no artifacts`);
  }
  return {
    response,
    bundleDigest: digestJson({ response, artifact_digest: artifactDigest }),
  };
}

async function copyReferenceEntry(source: string, target: string, subject: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new Error(`${subject} contains a symbolic link: ${source}`);
  if (metadata.isFile()) {
    if (metadata.nlink > 1) throw new Error(`${subject} contains a hard link: ${source}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, metadata.mode & 0o777);
    return;
  }
  if (!metadata.isDirectory())
    throw new Error(`${subject} contains an unsupported entry: ${source}`);
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source)).sort()) {
    await copyReferenceEntry(join(source, entry), join(target, entry), subject);
  }
}

export async function snapshotReferenceBundle(
  source: string,
  target: string,
  subject: string,
): Promise<{ response: z.infer<typeof generationResponseSchema>; bundleDigest: string }> {
  const original = await validateAndDigestReferenceBundle(source, subject);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "response.json"),
    `${JSON.stringify(original.response, null, 2)}\n`,
    "utf8",
  );
  for (const artifact of original.response.artifacts) {
    const artifactSource = resolveContained(source, artifact.path, "reference artifact");
    await rejectSymlinkComponents(source, artifactSource, "reference artifact");
    await copyReferenceEntry(artifactSource, join(target, artifact.path), subject);
  }
  const snapshot = await validateAndDigestReferenceBundle(target, subject);
  if (snapshot.bundleDigest !== original.bundleDigest) {
    throw new Error(`${subject} changed while creating its snapshot`);
  }
  return snapshot;
}

export interface LoadedReferenceSetCase {
  manifest: ReferenceSet["cases"][number];
  bundlePath: string;
}

export interface LoadedReferenceSet {
  manifest: ReferenceSet;
  manifestPath: string;
  directory: string;
  cases: LoadedReferenceSetCase[];
}

async function readStructuredFile(path: string): Promise<unknown> {
  const source = await readTextBounded(path, MAXIMUM_MANIFEST_BYTES, { rejectHardLinks: true });
  return path.endsWith(".json") ? JSON.parse(source) : parse(source);
}

async function resolveReferenceBundle(
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

export async function loadReferenceSet(pathInput: string): Promise<LoadedReferenceSet> {
  const manifestPath = resolve(pathInput);
  const directory = dirname(manifestPath);
  const manifest = referenceSetSchema.parse(await readStructuredFile(manifestPath));
  const computedDigest = referenceSetDigest(manifest);
  if (manifest.digest !== computedDigest) {
    throw new Error(
      `reference-set digest mismatch: expected ${manifest.digest}, computed ${computedDigest}`,
    );
  }
  const cases: LoadedReferenceSetCase[] = [];
  for (const item of manifest.cases) {
    const bundlePath = await resolveReferenceBundle(directory, item.bundle, "reference-set bundle");
    const { bundleDigest } = await validateAndDigestReferenceBundle(
      bundlePath,
      `reference-set bundle for ${item.id}`,
    );
    if (bundleDigest !== item.bundle_digest) {
      throw new Error(
        `reference-set bundle digest mismatch for ${item.id}: expected ${item.bundle_digest}, computed ${bundleDigest}`,
      );
    }
    cases.push({ manifest: item, bundlePath });
  }
  return { manifest, manifestPath, directory, cases };
}
