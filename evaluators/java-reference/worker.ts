#!/usr/bin/env bun

import { resolve } from "node:path";
import { serveEvaluator } from "../shared/protocol.ts";
import { createReferenceEvaluator } from "./evaluate.ts";

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
