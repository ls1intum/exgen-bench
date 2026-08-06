#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../shared/protocol.ts";
import { createStaticEvaluator } from "./evaluate.ts";

/**
 * The suite directory is an argv argument so that which construct specifications an evaluation was
 * measured against is part of the evaluator's configuration digest.
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
