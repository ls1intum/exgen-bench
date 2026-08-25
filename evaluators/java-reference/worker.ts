#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../shared/protocol.ts";
import { createReferenceEvaluator } from "./evaluate.ts";

/**
 * The reference-set manifest is an argv argument so the exact data interface used for evaluation is
 * part of the evaluator's configuration digest. The restricted bundles never enter the generator
 * request or Artemis.
 */
export function referenceSetPathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--references");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) {
    throw new Error("java-reference requires --references <reference-set manifest>");
  }
  return value;
}

if (import.meta.main) {
  await serveEvaluator(
    createReferenceEvaluator(resolve(referenceSetPathFromArgv(process.argv.slice(2)))),
  );
}
