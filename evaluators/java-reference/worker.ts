#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../shared/protocol.ts";
import { createReferenceEvaluator } from "./evaluate.ts";

/**
 * The suite directory is an argv argument so that which golden references an evaluation was measured
 * against is part of the evaluator's configuration digest. The references themselves are restricted
 * assets and never enter the bundle, the dataset, or Artemis.
 */
export function suitePathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--suite");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) {
    throw new Error("java-reference requires --suite <golden reference directory>");
  }
  return value;
}

if (import.meta.main) {
  await serveEvaluator(createReferenceEvaluator(resolve(suitePathFromArgv(process.argv.slice(2)))));
}
