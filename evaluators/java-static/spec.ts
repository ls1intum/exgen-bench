import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { analyseJavaFiles, type BundleFile } from "../shared/bundle.ts";
import type { JavaUnit } from "../shared/java/structure.ts";
import { callsItself } from "../shared/java/structure.ts";

/**
 * The required-construct specification: a versioned, restricted suite asset that says, per case,
 * which constructs a solution must and must not use.
 *
 * It is a *suite* asset rather than a dataset field on purpose. The dataset contract forbids anything
 * that gives away the answer from the public dataset file, and "this exercise must be solved with
 * recursion" is exactly that. Specs live under `suites/<name>/cases/<case_id>.yaml`, are digested
 * into the suite manifest, and are versioned independently of the briefs.
 *
 * Authoring the real specs for the corpus is WP9, and needs a second coder and an inter-coder
 * agreement report -- a single-rater construct label cannot be reported as validated. Until then the
 * only specs that exist are the fixtures, and every case without a spec scores `not_applicable`.
 */

/** The closed construct vocabulary. A closed set is what lets `concept.missing` be a public string metric. */
export const CONSTRUCTS = [
  "array",
  "conditional",
  "generics",
  "inheritance",
  "lambda",
  "loop",
  "recursion",
  "stream_api",
  "string_formatting",
  "switch",
  "ternary",
  "try_catch",
] as const;

export type Construct = (typeof CONSTRUCTS)[number];

export const constructSpecSchema = z
  .object({
    schema_version: z.literal("1"),
    case_id: z.string().min(1),
    required_constructs: z.array(z.enum(CONSTRUCTS)).default([]),
    forbidden_constructs: z.array(z.enum(CONSTRUCTS)).default([]),
    complexity: z
      .object({
        max_cyclomatic: z.number().int().min(1).max(200).optional(),
        max_cognitive: z.number().int().min(1).max(200).optional(),
      })
      .strict()
      .default({}),
    /** Free-text rationale kept with the spec so a second coder can adjudicate against it (WP9). */
    rationale: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    const overlap = spec.required_constructs.filter((construct) =>
      spec.forbidden_constructs.includes(construct),
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["forbidden_constructs"],
        message: `a construct cannot be both required and forbidden: ${overlap.join(", ")}`,
      });
    }
  });

export type ConstructSpec = z.infer<typeof constructSpecSchema>;

export async function loadConstructSpec(
  suiteDirectory: string,
  caseId: string,
): Promise<ConstructSpec | null> {
  const path = resolve(join(suiteDirectory, "cases", `${caseId}.yaml`));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const spec = constructSpecSchema.parse(parseYaml(raw));
  if (spec.case_id !== caseId) {
    throw new Error(`construct spec ${path} declares case ${spec.case_id}`);
  }
  return spec;
}

/**
 * Which constructs a set of Java units uses.
 *
 * Syntactic presence only -- see `shared/java/structure.ts`. A construct is detected when its syntax
 * appears anywhere in the analysed files, not when it executes, and the checker under-reports rather
 * than guesses.
 */
export function detectConstructs(units: JavaUnit[]): Set<Construct> {
  const present = new Set<Construct>();
  for (const unit of units) {
    const values = unit.tokens.map((token) => token.value);
    const has = (value: string): boolean => values.includes(value);

    if (has("for") || has("while") || has("do")) {
      present.add("loop");
    }
    if (has("if") || has("switch")) {
      present.add("conditional");
    }
    if (has("switch")) {
      present.add("switch");
    }
    if (has("try") || has("catch")) {
      present.add("try_catch");
    }
    if (has("extends")) {
      present.add("inheritance");
    }
    if (has("->") || has("::")) {
      present.add("lambda");
    }
    if (has("?")) {
      present.add("ternary");
      present.add("conditional");
    }
    if (unit.tokens.some((token, index) => token.value === "[" && values[index + 1] === "]")) {
      present.add("array");
    }
    if (
      unit.imports.some((name) => name.startsWith("java.util.stream")) ||
      unit.tokens.some(
        (token, index) =>
          token.value === "." &&
          ["stream", "collect", "mapToInt", "filter", "reduce"].includes(values[index + 1] ?? ""),
      ) ||
      has("Collectors")
    ) {
      present.add("stream_api");
    }
    if (
      unit.tokens.some(
        (token, index) =>
          token.value === "." &&
          ["format", "formatted", "printf"].includes(values[index + 1] ?? ""),
      ) ||
      has("StringBuilder")
    ) {
      present.add("string_formatting");
    }
    if (isGenericUse(unit)) {
      present.add("generics");
    }
    if (unit.methods.some((method) => callsItself(unit, method))) {
      present.add("recursion");
    }
  }
  return present;
}

/**
 * `<` is ambiguous in Java's token stream: it is both less-than and the start of a type argument
 * list. A `<` counts as generics only when it is preceded by an identifier and the matching `>`
 * appears before any statement terminator, which is conservative in the direction of missing generics
 * rather than inventing them.
 */
function isGenericUse(unit: JavaUnit): boolean {
  for (let index = 1; index < unit.tokens.length; index += 1) {
    if (unit.tokens[index]?.value !== "<") {
      continue;
    }
    if (unit.tokens[index - 1]?.kind !== "identifier") {
      continue;
    }
    let depth = 0;
    for (let scan = index; scan < unit.tokens.length; scan += 1) {
      const value = unit.tokens[scan]?.value;
      if (value === "<") {
        depth += 1;
      } else if (value === ">") {
        depth -= 1;
        if (depth === 0) {
          return true;
        }
      } else if (value === ";" || value === "{" || value === "(" || value === ")") {
        break;
      }
    }
  }
  return false;
}

export function detectConstructsInFiles(files: BundleFile[]): {
  constructs: Set<Construct>;
  units: JavaUnit[];
  unparsed: Array<{ path: string; reason: string }>;
} {
  const { units, unparsed } = analyseJavaFiles(files);
  return { constructs: detectConstructs(units), units, unparsed };
}
