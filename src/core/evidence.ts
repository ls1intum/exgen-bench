import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { digestJson } from "./canonical.ts";
import { writeJsonAtomic } from "./files.ts";

export interface EvidenceEntry {
  path: string;
  sha256: string;
  size: number;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

async function collectEvidence(
  root: string,
  current: string,
  entries: EvidenceEntry[],
): Promise<void> {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) {
    throw new Error(`evidence contains a symbolic link: ${relative(root, current)}`);
  }
  if (metadata.isFile()) {
    const path = relative(root, current).split(sep).join("/");
    if (path !== "evidence-manifest.json") {
      entries.push({ path, sha256: await sha256File(current), size: metadata.size });
    }
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`evidence contains a special file: ${relative(root, current)}`);
  }
  const children = await readdir(current);
  children.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const child of children) {
    await collectEvidence(root, join(current, child), entries);
  }
}

export async function buildEvidenceManifest(
  directory: string,
): Promise<{ schema_version: "1"; files: EvidenceEntry[] }> {
  const entries: EvidenceEntry[] = [];
  await collectEvidence(directory, directory, entries);
  return { schema_version: "1", files: entries };
}

export async function writeEvidenceManifest(directory: string): Promise<string> {
  const manifest = await buildEvidenceManifest(directory);
  const digest = digestJson(manifest);
  await writeJsonAtomic(join(directory, "evidence-manifest.json"), { ...manifest, digest });
  return digest;
}
