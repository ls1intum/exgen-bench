import { analyseJavaUnit } from "../../kit/java/structure.ts";
import type {
  BuildBackend,
  BuildJob,
  SubmissionBuild,
} from "../../tier1-deterministic/java-oracle/backend.ts";
import type { SourceFile } from "./diff.ts";

export const CONSTRAINTS = ["stream_api", "while_loop"] as const;
export type Constraint = (typeof CONSTRAINTS)[number];
export interface ConstraintProbe {
  path: string;
  line: number;
  method: string;
  constraint: Constraint;
  start: number;
  end: number;
  replacement: string;
}
export interface ConstraintResult {
  probe: ConstraintProbe;
  outcome: "accepted" | "rejected" | "not_compiled" | "incomplete";
  tests: number;
}

/** Closed, conservative transformations. Unsupported shapes produce no probe, never an inferred pass. */
export function constraintProbes(
  files: SourceFile[],
  constraints: Constraint[],
): ConstraintProbe[] {
  const result: ConstraintProbe[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!file.path.endsWith(".java")) continue;
    const unit = analyseJavaUnit(file.path, file.content);
    for (const method of unit.methods) {
      if (
        method.isConstructor ||
        method.name === "main" ||
        method.bodyStart === null ||
        method.bodyEnd === null
      )
        continue;
      const open = unit.tokens[method.bodyStart]!;
      const close = unit.tokens[method.bodyEnd]!;
      const body = file.content.slice(open.end, close.start);
      const base = {
        path: file.path,
        method: `${method.typeName}.${method.name}`,
        line: method.line,
        start: open.end,
        end: close.start,
      };
      if (constraints.includes("while_loop")) {
        const loops = unit.tokens
          .slice(method.bodyStart + 1, method.bodyEnd)
          .filter((t) => t.value === "while");
        if (loops.length > 0) {
          let replacement = body;
          // while (condition) becomes for (; condition;): the loop body is unchanged.
          const tokens = unit.tokens.slice(method.bodyStart + 1, method.bodyEnd);
          const edits: Array<{ start: number; end: number; text: string }> = [];
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i]?.value !== "while" || tokens[i + 1]?.value !== "(") continue;
            let depth = 1;
            let end = i + 2;
            for (; end < tokens.length; end++) {
              if (tokens[end]?.value === "(") depth++;
              if (tokens[end]?.value === ")" && --depth === 0) break;
            }
            if (depth !== 0) continue;
            edits.push(
              {
                start: tokens[i]!.start - open.end,
                end: tokens[i + 1]!.end - open.end,
                text: "for (;",
              },
              {
                start: tokens[end]!.start - open.end,
                end: tokens[end]!.end - open.end,
                text: ";)",
              },
            );
          }
          for (const edit of edits.sort((a, b) => b.start - a.start))
            replacement =
              replacement.slice(0, edit.start) + edit.text + replacement.slice(edit.end);
          if (edits.length) result.push({ ...base, constraint: "while_loop", replacement });
        }
      }
      if (!constraints.includes("stream_api") || body.includes("__exgen")) continue;
      const match =
        /^\s*return\s+([\w.]+)\.stream\(\)\s*\.filter\(\s*(\w+)\s*->\s*([\s\S]+?)\)\s*(?:\.map\(\s*(\w+)\s*->\s*([\s\S]+?)\)\s*)?\.(count|toList)\(\)\s*;\s*$/.exec(
          body,
        );
      if (
        !match ||
        (match[4] && match[4] !== match[2]) ||
        (body.match(/\.(?:parallelStream|stream)\s*\(/g)?.length ?? 0) !== 1
      )
        continue;
      const [, input, variable, predicate, , mapping, terminal] = match;
      let replacement: string;
      if (terminal === "count" && !mapping)
        replacement = `\nlong __exgenCount = 0;\nfor (var ${variable} : ${input}) { if (${predicate}) __exgenCount++; }\nreturn __exgenCount;\n`;
      else if (terminal === "toList" && mapping) {
        const header = file.content.slice(0, open.start).split(/\n/).at(-1) ?? "";
        const type = /(?:java\.util\.)?List\s*<\s*([\w.]+)\s*>/.exec(header)?.[1];
        if (!type) continue;
        replacement = `\njava.util.List<${type}> __exgenValues = new java.util.ArrayList<>();\nfor (var ${variable} : ${input}) { if (${predicate}) __exgenValues.add(${mapping}); }\nreturn __exgenValues;\n`;
      } else continue;
      result.push({ ...base, constraint: "stream_api", replacement });
    }
  }
  return result;
}

export function classifyProbe(
  build: SubmissionBuild,
  expected: string[],
): ConstraintResult["outcome"] {
  if (!build.compiled) return "not_compiled";
  if (!build.tests_executed || build.test_cases.length === 0) return "incomplete";
  if (build.test_cases.some((t) => !t.passed)) return "rejected";
  const names = new Set(build.test_cases.map((t) => t.name));
  return expected.every((name) => names.has(name)) ? "accepted" : "incomplete";
}

export async function runConstraintProbes(
  backend: BuildBackend,
  job: BuildJob,
  probes: ConstraintProbe[],
  expected: string[],
  signal: AbortSignal,
): Promise<ConstraintResult[]> {
  const results: ConstraintResult[] = [];
  for (const probe of probes) {
    const files = job.bundle.solution.map((f) =>
      f.path === probe.path
        ? {
            path: f.path,
            bytes: f.bytes,
            content:
              f.content.slice(0, probe.start) + probe.replacement + f.content.slice(probe.end),
          }
        : f,
    );
    const build = await backend.build(
      { ...job, analysis: false, bundle: { ...job.bundle, solution: files } },
      signal,
    );
    results.push({
      probe,
      outcome: classifyProbe(build.solution, expected),
      tests: build.solution.test_cases.length,
    });
  }
  return results;
}
