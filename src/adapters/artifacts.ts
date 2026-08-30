import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { GenerationResponse } from "../contracts.ts";
import { canonicalJson, sha256 } from "../core/canonical.ts";
import { rejectSymlinkComponents, resolveContained } from "./paths.ts";

interface TreeEntry {
  path: string;
  type: "directory" | "file";
  mode?: number;
  sha256?: string;
  size?: number;
}

interface WalkBudget {
  entries: number;
  bytes: number;
}

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 64;

async function walk(
  root: string,
  current: string,
  entries: Map<string, TreeEntry>,
  budget: WalkBudget,
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) {
    throw new Error(`artifact tree exceeds maximum depth ${MAX_DEPTH}`);
  }
  budget.entries += 1;
  if (budget.entries > MAX_ENTRIES) {
    throw new Error(`artifact tree exceeds maximum entry count ${MAX_ENTRIES}`);
  }

  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in artifacts: ${relative(root, current)}`);
  }
  if (metadata.isFile()) {
    if (metadata.nlink > 1) {
      throw new Error(`hard links are not allowed in artifacts: ${relative(root, current)}`);
    }
    budget.bytes += metadata.size;
    if (budget.bytes > MAX_BYTES) {
      throw new Error(`artifact tree exceeds maximum byte count ${MAX_BYTES}`);
    }
    const contents = await readFile(current);
    const path = relative(root, current).split(sep).join("/");
    entries.set(path, {
      path,
      type: "file",
      mode: metadata.mode & 0o777,
      sha256: sha256(contents),
      size: contents.byteLength,
    });
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`artifact is neither a regular file nor directory: ${current}`);
  }
  const directoryPath = relative(root, current).split(sep).join("/") || ".";
  entries.set(directoryPath, { path: directoryPath, type: "directory" });
  const directoryEntries = await readdir(current);
  directoryEntries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const entry of directoryEntries) {
    // A candidate exercise is a problem statement, starter code, a reference solution and tests; the
    // history of the repository it was exported from is provenance, not content, and is recorded
    // separately (generation-evidence.json). `.git/index` embeds each entry's ctime and mtime, so
    // including it would make the digest depend on when the export ran rather than on what it
    // contains (issue #18) -- true of a repository root and of a vendored checkout or submodule found
    // at any depth, so this excludes every `.git` entry, not only one at the artifact root.
    if (entry === ".git") {
      continue;
    }
    await walk(root, resolve(current, entry), entries, budget, depth + 1);
  }
}

function validateProgrammingExerciseRoles(
  response: GenerationResponse,
  root: string,
): Promise<void>[] {
  if (response.status !== "succeeded") {
    return [];
  }
  const byRole = new Map(response.artifacts.map((artifact) => [artifact.role, artifact]));
  const required = ["problem_statement", "template", "solution", "tests"];
  const missing = required.filter((role) => !byRole.has(role));
  if (missing.length > 0) {
    throw new Error(`programming exercise is missing artifact roles: ${missing.join(", ")}`);
  }

  return required.map(async (role) => {
    const artifact = byRole.get(role);
    if (!artifact) {
      return;
    }
    const path = resolveContained(root, artifact.path, "artifact");
    await rejectSymlinkComponents(root, path, "artifact");
    const metadata = await lstat(path);
    if (role === "problem_statement" && !metadata.isFile()) {
      throw new Error("problem_statement must be a regular file");
    }
    if (role !== "problem_statement" && !metadata.isDirectory()) {
      throw new Error(`${role} must be a directory`);
    }
  });
}

export async function validateAndDigestArtifacts(
  response: GenerationResponse,
  outputDirectory: string,
): Promise<string | undefined> {
  const outputMetadata = await lstat(outputDirectory);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("artifact output root must be a real directory, not a symbolic link");
  }
  const roles = response.artifacts.map((artifact) => artifact.role);
  if (new Set(roles).size !== roles.length) {
    throw new Error("artifact roles must be unique");
  }

  await Promise.all(validateProgrammingExerciseRoles(response, outputDirectory));

  if (response.artifacts.length === 0) {
    return undefined;
  }

  const treeEntries = new Map<string, TreeEntry>();
  const budget: WalkBudget = { entries: 0, bytes: 0 };
  for (const artifact of response.artifacts) {
    const path = resolveContained(outputDirectory, artifact.path, "artifact");
    await rejectSymlinkComponents(outputDirectory, path, "artifact");
    await walk(outputDirectory, path, treeEntries, budget, 0);
  }
  const sortedEntries = [...treeEntries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const artifacts = [...response.artifacts].sort((left, right) =>
    left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
  );
  return sha256(canonicalJson({ artifacts, entries: sortedEntries }));
}
