import { analyseJavaUnit } from "../../kit/java/structure.ts";
import type {
  BuildBackend,
  BuildJob,
  SubmissionBuild,
} from "../../tier1-deterministic/java-oracle/backend.ts";
import type { DiffFile } from "../shared/exercise.ts";
import type { SourceFile } from "./diff.ts";
import { changedLines } from "./mutation.ts";

export const CONSTRAINTS = ["stream_api", "while_loop"] as const;
export type Constraint = (typeof CONSTRAINTS)[number];
export interface ConstraintProbe {
  requirement?: string;
  path: string;
  line: number;
  method: string;
  constraint: Constraint;
  start: number;
  end: number;
  replacement: string;
}

export interface ConstraintRequirement {
  constraint: Constraint;
  method: string | null;
  evidence: string;
}

/** Only explicit English instructions, outside examples and code fences. No exercise identifiers. */
export function statementRequirements(statement: string): ConstraintRequirement[] {
  let fence: { marker: string; size: number } | null = null;
  const prose = statement
    .split("\n")
    .map((line) => {
      const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) {
        if (!fence) fence = { marker: delimiter[0]!, size: delimiter.length };
        else if (delimiter[0] === fence.marker && delimiter.length >= fence.size) fence = null;
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
  const requirements: ConstraintRequirement[] = [];
  let excludedLevel: number | null = null;
  for (const paragraph of prose.split(/\n\s*\n/)) {
    const heading = /^\s*(#{1,6})\s+(.+)/.exec(paragraph);
    if (heading) {
      const level = heading[1]!.length;
      if (excludedLevel !== null && level <= excludedLevel) excludedLevel = null;
      if (/\b(?:examples?|hints?|optional)\b/i.test(heading[2]!) && excludedLevel === null)
        excludedLevel = level;
      continue;
    }
    if (excludedLevel !== null || /^\s*>/.test(paragraph) || /^ {4}\S/.test(paragraph)) continue;
    const text = paragraph.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
    // A permission, suggestion or negation is not a positive requirement.
    if (
      /\b(?:may|might|can|could|optional|optionally|do not|don't|must not|not required|for example)\b/i.test(
        text,
      )
    )
      continue;
    const directive =
      /\b(?:implement|write|rewrite)\s+([A-Za-z_$][\w$]*)(?:\([^)]*\))?\s+(?:as|with|using)\s+(.+)/i.exec(
        text,
      );
    const global = /^(?:you\s+)?(?:must\s+use|use)\s+(.+)/i.exec(text);
    const instruction = directive?.[2] ?? global?.[1];
    if (!instruction) continue;
    const construct =
      /^(?:(?:a|an|the|one|single|Java)\s+)*(while\s+loop|streams?(?:\s+(?:API|pipeline))?)\b/i.exec(
        instruction,
      )?.[1];
    if (!construct) continue;
    requirements.push({
      constraint: /^while/i.test(construct) ? "while_loop" : "stream_api",
      method: directive?.[1] ?? null,
      evidence: text.split(/(?<=[.!?])\s/)[0]!,
    });
  }
  return requirements;
}

/** The same automatic plan is used by normal builds and archive refreshes. */
export function planConstraintChecks(
  statement: string,
  files: SourceFile[],
  diff: DiffFile[],
  configured: Constraint[] = [],
): { probes: ConstraintProbe[]; unsupported: Constraint[] } {
  const requirements = statementRequirements(statement);
  for (const constraint of configured)
    if (!requirements.some((r) => r.constraint === constraint))
      throw new Error(
        `Configured ${constraint} has no supported explicit requirement in the statement`,
      );
  const required = [...new Set(requirements.map((r) => r.constraint))];
  const changed = changedLines(diff);
  const probes = constraintProbes(files, required).flatMap((probe) => {
    const source = files.find((f) => f.path === probe.path)!;
    const last = source.content.slice(0, probe.end).split("\n").length;
    if (![...(changed.get(probe.path) ?? [])].some((line) => line >= probe.line && line <= last))
      return [];
    const requirement = requirements.find(
      (r) =>
        r.constraint === probe.constraint &&
        (r.method === null || probe.method.endsWith("." + r.method)),
    );
    return requirement ? [{ ...probe, requirement: requirement.evidence }] : [];
  });
  return {
    probes,
    unsupported: required.filter((c) =>
      requirements.some(
        (r) =>
          r.constraint === c &&
          !probes.some(
            (p) => p.constraint === c && (r.method === null || p.method.endsWith("." + r.method)),
          ),
      ),
    ),
  };
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
    const files = job.bundle.solution.map((f) => {
      if (f.path !== probe.path) return f;
      const content =
        f.content.slice(0, probe.start) + probe.replacement + f.content.slice(probe.end);
      return {
        path: f.path,
        bytes: new TextEncoder().encode(content).byteLength,
        content,
      };
    });
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
