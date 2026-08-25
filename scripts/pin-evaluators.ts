#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { workerConfigDigest, loadWorkerConfig } from "../evaluators/java-oracle/worker.ts";
import { implementationDigest, suiteDigest } from "../evaluators/shared/identity.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { loadReferenceSet } from "../src/data/reference-set.ts";

const root = resolve(import.meta.dir, "..");
const parsedArgs = parseArgs({
  args: process.argv.slice(2),
  options: { check: { type: "boolean", default: false } },
  strict: true,
  allowPositionals: false,
});
const stale: string[] = [];

for await (const relativePath of new Bun.Glob("evaluators/*/evaluator*.yaml").scan({
  cwd: root,
  onlyFiles: true,
})) {
  const path = join(root, relativePath);
  const directory = dirname(path);
  const source = await readFile(path, "utf8");
  const document = parseDocument(source);
  const config = processEvaluatorConfigSchema.parse(document.toJS());

  document.setIn(["evaluator", "implementation_digest"], await implementationDigest(directory));

  const referencesFlag = config.process.argv.indexOf("--references");
  if (referencesFlag >= 0) {
    const referencesPath = config.process.argv[referencesFlag + 1];
    if (referencesPath === undefined) throw new Error(`${relativePath} has no --references value`);
    const references = await loadReferenceSet(join(directory, referencesPath));
    document.setIn(["suite", "id"], references.manifest.package.id);
    document.setIn(["suite", "version"], references.manifest.package.version);
    document.setIn(["suite", "digest"], references.manifest.digest);
  } else {
    document.setIn(["suite", "digest"], await suiteDigest(directory));
  }

  const backendFlag = config.process.argv.indexOf("--config");
  if (backendFlag >= 0) {
    const backendPath = config.process.argv[backendFlag + 1];
    const digestFlag = config.process.argv.indexOf("--config-digest");
    if (backendPath === undefined || digestFlag < 0) {
      throw new Error(`${relativePath} must pair --config with --config-digest`);
    }
    const { config: backend } = await loadWorkerConfig(join(directory, backendPath));
    document.setIn(["process", "argv", digestFlag + 1], workerConfigDigest(backend));
  }

  const output = document.toString({ lineWidth: 100 });
  if (output === source) continue;
  if (parsedArgs.values.check) {
    stale.push(relative(root, path));
  } else {
    await writeFile(path, output, "utf8");
  }
}

if (stale.length > 0) {
  throw new Error(`stale evaluator pins: ${stale.sort().join(", ")}`);
}

if (!parsedArgs.values.check) {
  process.stdout.write(
    "Updated evaluator implementation, suite, and backend configuration pins.\n",
  );
}
