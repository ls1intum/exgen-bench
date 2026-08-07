import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { analyseJavaFiles, type BundleFile } from "../shared/bundle.ts";
import type { Token } from "../shared/java/lexer.ts";
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
 *
 * Several tokens are ambiguous in a token stream that was never parsed, and each is resolved in the
 * direction that misses a construct rather than inventing one:
 *
 *   - `?` is a ternary only outside a generic argument list; inside one (`List<?>`) it is a wildcard;
 *   - `extends`/`implements` are inheritance only in a type header; inside `<...>` (`<T extends N>`,
 *     `<? extends N>`) they are a type or wildcard bound, which is generics;
 *   - `->` is a lambda unless it is a switch rule (`case L ->`, `default ->`), the one arrow that is
 *     not one; a method reference (`::`) is always a lambda;
 *   - a stream needs a real stream signal (the `java.util.stream` package, `Collectors`, or a
 *     `.stream(`/`.parallelStream(` pipeline), so `Optional.filter` is not mistaken for one.
 */
export function detectConstructs(units: JavaUnit[]): Set<Construct> {
  const present = new Set<Construct>();
  for (const unit of units) {
    const tokens = unit.tokens;
    const values = tokens.map((token) => token.value);
    const has = (value: string): boolean => values.includes(value);
    const spans = genericTypeArgumentSpans(tokens);
    const insideGeneric = (index: number): boolean =>
      spans.some((span) => index > span.open && index < span.close);

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
    if (
      tokens.some(
        (token, index) =>
          token.kind === "keyword" &&
          (token.value === "extends" || token.value === "implements") &&
          !insideGeneric(index),
      )
    ) {
      present.add("inheritance");
    }
    if (
      tokens.some(
        (token, index) =>
          token.value === "::" || (token.value === "->" && !isSwitchRuleArrow(tokens, index)),
      )
    ) {
      present.add("lambda");
    }
    if (tokens.some((token, index) => token.value === "?" && !insideGeneric(index))) {
      present.add("ternary");
      present.add("conditional");
    }
    if (tokens.some((token, index) => token.value === "[" && values[index + 1] === "]")) {
      present.add("array");
    }
    if (
      unit.imports.some((name) => name.startsWith("java.util.stream")) ||
      has("Collectors") ||
      tokens.some(
        (token, index) =>
          token.value === "." &&
          (values[index + 1] === "stream" || values[index + 1] === "parallelStream") &&
          values[index + 2] === "(",
      )
    ) {
      present.add("stream_api");
    }
    if (
      tokens.some(
        (token, index) =>
          token.value === "." &&
          ["format", "formatted", "printf"].includes(values[index + 1] ?? ""),
      ) ||
      has("StringBuilder")
    ) {
      present.add("string_formatting");
    }
    if (spans.length > 0) {
      present.add("generics");
    }
    if (unit.methods.some((method) => callsItself(unit, method))) {
      present.add("recursion");
    }
  }
  return present;
}

/** Modifiers that can immediately precede a generic method's type-parameter list. */
const GENERIC_HEAD_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "final",
  "abstract",
  "default",
  "synchronized",
  "native",
  "strictfp",
]);

/**
 * `<` is both less-than and the opener of a type-argument or type-parameter list. It opens a generic
 * list when the previous token is an identifier (`List<...>`, `Box<T>`), or when it sits where a
 * comparison cannot start -- straight after a member boundary (`{`, `}`, `;`) or a method modifier,
 * which is the generic-method form `public <T extends N> ...`. The identifier case is still ambiguous
 * with `a < b`, so the caller confirms it by finding the matching `>` before any statement delimiter.
 */
function opensTypeArgumentList(previous: Token | undefined): boolean {
  if (previous === undefined) {
    return false;
  }
  if (previous.kind === "identifier") {
    return true;
  }
  if (previous.value === "{" || previous.value === "}" || previous.value === ";") {
    return true;
  }
  return previous.kind === "keyword" && GENERIC_HEAD_KEYWORDS.has(previous.value);
}

/**
 * The `<...>` spans that are generic argument or parameter lists, as `{ open, close }` token indices.
 * A `?` or an `extends` strictly inside a span is a wildcard or a bound, not a ternary or a supertype.
 * The match abandons a candidate `<` on the first statement delimiter, so a comparison chain yields no
 * span; in the residual ambiguous case the effect is a missed ternary, never an invented one.
 */
function genericTypeArgumentSpans(tokens: Token[]): Array<{ open: number; close: number }> {
  const spans: Array<{ open: number; close: number }> = [];
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "<" || !opensTypeArgumentList(tokens[index - 1])) {
      continue;
    }
    let depth = 0;
    for (let scan = index; scan < tokens.length; scan += 1) {
      const value = tokens[scan]?.value;
      if (value === "<") {
        depth += 1;
      } else if (value === ">") {
        depth -= 1;
        if (depth === 0) {
          spans.push({ open: index, close: scan });
          break;
        }
      } else if (value === ";" || value === "{" || value === "(" || value === ")") {
        break;
      }
    }
  }
  return spans;
}

/**
 * Whether the `->` at `arrowIndex` is a switch rule (`case L ->`, `default ->`) rather than a lambda.
 * Scanning left to the nearest arm or statement boundary (`;`, `{`, `}`, or another `->`), a `case`
 * or `default` keyword reached first marks a switch rule; a lambda's arrow is instead reached from
 * its parameter list. Parentheses and commas are stepped over so multi-label, guarded and
 * record-pattern arms (`case A, B ->`, `case X when g ->`, `case P(var a) ->`) are not misread.
 */
function isSwitchRuleArrow(tokens: Token[], arrowIndex: number): boolean {
  for (let index = arrowIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) {
      return false;
    }
    if (token.kind === "keyword" && (token.value === "case" || token.value === "default")) {
      return true;
    }
    if (token.value === ";" || token.value === "{" || token.value === "}" || token.value === "->") {
      return false;
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
