#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../../kit/protocol.ts";
import { createReferenceEvaluator, REFERENCE_METRIC_VERSION } from "./evaluate.ts";

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
    { metricVersion: REFERENCE_METRIC_VERSION },
  );
}
