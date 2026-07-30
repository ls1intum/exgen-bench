import { lstat, opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { digestJson } from "./canonical.ts";
import { writeJsonAtomic } from "./files.ts";

export interface EvidenceEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface EvidenceLimits {
  maximumEntries: number;
  maximumBytes: number;
  maximumDepth: number;
}

const defaultEvidenceLimits: EvidenceLimits = {
  maximumEntries: 20_000,
  maximumBytes: 512 * 1024 * 1024,
  maximumDepth: 64,
};

export async function sha256File(
  path: string,
  maximumBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw new Error(`file changed while hashing: ${path}`);
    }
    hasher.update(chunk);
  }
  if (Number.isFinite(maximumBytes) && bytes !== maximumBytes) {
    throw new Error(`file changed while hashing: ${path}`);
  }
  return hasher.digest("hex");
}

async function collectEvidence(
  root: string,
  current: string,
  entries: EvidenceEntry[],
  limits: EvidenceLimits,
  budget: { entries: number; bytes: number },
  depth: number,
): Promise<void> {
  if (depth > limits.maximumDepth) {
    throw new Error(`evidence exceeds maximum depth ${limits.maximumDepth}`);
  }
  const metadata = await lstat(current);
  const path = relative(root, current).split(sep).join("/");
  if (metadata.isSymbolicLink()) {
    throw new Error(`evidence contains a symbolic link: ${path}`);
  }
  if (path === "evidence-manifest.json" && metadata.isFile()) {
    return;
  }
  if (path !== "") {
    budget.entries += 1;
    if (budget.entries > limits.maximumEntries) {
      throw new Error(`evidence exceeds maximum entry count ${limits.maximumEntries}`);
    }
  }
  if (metadata.isFile()) {
    if (metadata.nlink > 1) {
      throw new Error(`evidence contains a hard-linked file: ${path}`);
    }
    budget.bytes += metadata.size;
    if (budget.bytes > limits.maximumBytes) {
      throw new Error(`evidence exceeds maximum size ${limits.maximumBytes} bytes`);
    }
    entries.push({
      path,
      sha256: await sha256File(current, metadata.size),
      size: metadata.size,
    });
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`evidence contains a special file: ${path}`);
  }
  const children: string[] = [];
  const directory = await opendir(current);
  let countableChildren = 0;
  for await (const child of directory) {
    children.push(child.name);
    if (!(path === "" && child.name === "evidence-manifest.json")) {
      countableChildren += 1;
    }
    if (budget.entries + countableChildren > limits.maximumEntries) {
      throw new Error(`evidence exceeds maximum entry count ${limits.maximumEntries}`);
    }
  }
  children.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const child of children) {
    await collectEvidence(root, join(current, child), entries, limits, budget, depth + 1);
  }
}

export async function buildEvidenceManifest(
  directory: string,
  limits: EvidenceLimits = defaultEvidenceLimits,
): Promise<{ schema_version: "1"; files: EvidenceEntry[] }> {
  const entries: EvidenceEntry[] = [];
  await collectEvidence(directory, directory, entries, limits, { entries: 0, bytes: 0 }, 0);
  return { schema_version: "1", files: entries };
}

export async function writeEvidenceManifest(directory: string): Promise<string> {
  const manifest = await buildEvidenceManifest(directory);
  const digest = digestJson(manifest);
  await writeJsonAtomic(join(directory, "evidence-manifest.json"), { ...manifest, digest });
  return digest;
}
