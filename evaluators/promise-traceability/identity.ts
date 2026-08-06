import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestJson, sha256 } from "../../src/core/canonical.ts";

export const IMPLEMENTATION_FILES = [
  "bundle.ts",
  "java-tests.ts",
  "model.ts",
  "scores.ts",
  "statement.ts",
  "traceability.ts",
  "worker.ts",
];

export const SUITE_FILES = ["SUITE.md", "metric-cards.json"];

async function treeDigest(directory: string, names: string[]): Promise<string> {
  const entries: Record<string, string> = {};
  for (const name of [...names].sort()) {
    entries[name] = sha256(await readFile(join(directory, name)));
  }
  return digestJson(entries);
}

export async function implementationDigest(directory = import.meta.dir): Promise<string> {
  return treeDigest(directory, IMPLEMENTATION_FILES);
}

export async function suiteDigest(directory = import.meta.dir): Promise<string> {
  return treeDigest(directory, SUITE_FILES);
}

if (import.meta.main) {
  process.stdout.write(
    `implementation_digest: ${await implementationDigest()}\nsuite digest: ${await suiteDigest()}\n`,
  );
}
