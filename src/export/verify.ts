import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256 } from "../core/canonical.ts";

const releaseManifestSchema = z
  .object({
    schema_version: z.literal("1"),
    release: z.object({ id: z.string(), version: z.string() }).passthrough(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().nonnegative(),
          media_type: z.string().min(1),
        })
        .strict(),
    ),
  })
  .passthrough();

function contained(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`release file path must be relative: ${path}`);
  }
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`release file escapes its root: ${path}`);
  }
  return absolute;
}

async function collectReleaseFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const metadata = await lstat(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (metadata.isSymbolicLink()) {
      throw new Error(`release contains a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectReleaseFiles(root, path)));
    } else if (metadata.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`release contains a special file: ${relativePath}`);
    }
  }
  return files.sort();
}

export async function verifyRelease(releaseDirectoryInput: string): Promise<{
  releaseId: string;
  version: string;
  files: number;
  manifestSha256: string;
}> {
  const releaseDirectory = resolve(releaseDirectoryInput);
  const manifestPath = join(releaseDirectory, "release-manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error("release manifest is not a regular file");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = releaseManifestSchema.parse(JSON.parse(manifestText));
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    throw new Error("release manifest contains duplicate file paths");
  }
  const expectedFiles = new Set([
    "release-manifest.json",
    ...manifest.files.map((file) => file.path),
  ]);
  const actualFiles = await collectReleaseFiles(releaseDirectory);
  const unexpected = actualFiles.filter((path) => !expectedFiles.has(path));
  const absent = [...expectedFiles].filter((path) => !actualFiles.includes(path));
  if (unexpected.length > 0 || absent.length > 0) {
    throw new Error(
      `release file inventory mismatch; unexpected=[${unexpected.join(", ")}], absent=[${absent.join(", ")}]`,
    );
  }
  for (const file of manifest.files) {
    const path = contained(releaseDirectory, file.path);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`release entry is not a regular file: ${file.path}`);
    }
    const contents = new Uint8Array(await readFile(path));
    if (contents.byteLength !== file.bytes || sha256(contents) !== file.sha256) {
      throw new Error(`release checksum mismatch: ${file.path}`);
    }
  }
  return {
    releaseId: manifest.release.id,
    version: manifest.release.version,
    files: manifest.files.length,
    manifestSha256: sha256(manifestText),
  };
}
