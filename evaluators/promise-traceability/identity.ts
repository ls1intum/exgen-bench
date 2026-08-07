import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { digestJson, sha256 } from "../../src/core/canonical.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const ENTRYPOINT = "worker.ts";
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*"(\.[^"]*)"/g;

const SUITE_FILES = ["SUITE.md", "metric-cards.json"];

/**
 * Every module the worker loads, transitively, keyed by repository-relative path. Bare specifiers
 * are excluded: `bun.lock` pins those. Derived from the import graph rather than a hand-kept list,
 * so no module can change what is measured without changing the evaluator's identity.
 */
export async function implementationFiles(directory = import.meta.dir): Promise<string[]> {
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

export async function implementationDigest(directory = import.meta.dir): Promise<string> {
  const entries: Record<string, string> = {};
  for (const file of await implementationFiles(directory)) {
    entries[file] = sha256(await readFile(join(REPOSITORY_ROOT, file)));
  }
  return digestJson(entries);
}

export async function suiteDigest(directory = import.meta.dir): Promise<string> {
  const entries: Record<string, string> = {};
  for (const name of SUITE_FILES) {
    entries[name] = sha256(await readFile(join(directory, name)));
  }
  return digestJson(entries);
}

if (import.meta.main) {
  process.stdout.write(
    `evaluator.implementation_digest: ${await implementationDigest()}\nsuite.digest: ${await suiteDigest()}\n`,
  );
}
