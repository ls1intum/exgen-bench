#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../shared/protocol.ts";
import { createStaticEvaluator } from "./evaluate.ts";

/**
 * The suite directory is an argv argument because argv is recorded verbatim in the evaluator's
 * configuration digest. That pins the *path* the specs were read from, not their content: editing a
 * `cases/<case_id>.yaml` in place changes what is measured without changing any digest, so a study
 * has to pin the specs through the suite manifest as well.
 */
export function suitePathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--suite");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) {
    throw new Error("java-static requires --suite <construct specification directory>");
  }
  return value;
}

if (import.meta.main) {
  await serveEvaluator(createStaticEvaluator(resolve(suitePathFromArgv(process.argv.slice(2)))));
}
