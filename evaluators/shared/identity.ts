import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { digestJson, sha256 } from "../../src/core/canonical.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const ENTRYPOINT = "worker.ts";
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*"(\.[^"]*)"/g;

/**
 * Every module an evaluator's worker loads, transitively, keyed by repository-relative path. Bare
 * specifiers are excluded: `bun.lock` pins those. Walking the import graph rather than naming a
 * file means no module can change what is measured while the evaluator's identity stays the same —
 * a worker is usually an argv shim, and the measurement is everything it reaches.
 */
export async function implementationFiles(directory: string): Promise<string[]> {
  const visited = new Set<string>();
  const pending = [resolve(directory, ENTRYPOINT)];
  while (pending.length > 0) {
    const module = pending.pop() as string;
    if (visited.has(module)) {
      continue;
    }
    visited.add(module);
    const source = await readFile(module, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      pending.push(resolve(dirname(module), match[1] as string));
    }
  }
  return [...visited].map((module) => relative(REPOSITORY_ROOT, module)).sort();
}

export async function implementationDigest(directory: string): Promise<string> {
  const entries: Record<string, string> = {};
  for (const file of await implementationFiles(directory)) {
    entries[file] = sha256(await readFile(join(REPOSITORY_ROOT, file)));
  }
  return digestJson(entries);
}

/**
 * Digest over the files that define what an evaluator promises: its suite document, and its own
 * metric cards when it has them rather than sharing the family's.
 */
export async function suiteDigest(directory: string): Promise<string> {
  const entries: Record<string, string> = {};
  for (const name of ["SUITE.md", "metric-cards.json"]) {
    const path = join(directory, name);
    if (await Bun.file(path).exists()) {
      entries[name] = sha256(await readFile(path));
    }
  }
  return digestJson(entries);
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (directory === undefined) {
    process.stderr.write("usage: bun run evaluators/shared/identity.ts <evaluator-directory>\n");
    process.exit(2);
  }
  process.stdout.write(
    `evaluator.implementation_digest: ${await implementationDigest(directory)}\n` +
      `suite.digest: ${await suiteDigest(directory)}\n`,
  );
}
