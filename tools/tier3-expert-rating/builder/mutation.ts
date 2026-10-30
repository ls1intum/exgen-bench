import type { BundleFile } from "../../kit/bundle.ts";
import type { Token } from "../../kit/java/lexer.ts";
import { analyseJavaUnit, type MethodDeclaration } from "../../kit/java/structure.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
  TestCaseResult,
} from "../../tier1-deterministic/java-oracle/backend.ts";
import type { DiffFile } from "../shared/exercise.ts";
import type { SourceFile } from "./diff.ts";
import { failureKind } from "./tests.ts";

/**
 * Wrong variants of the sample solution, for the test overview: each changes one place of the code a
 * student writes with a classic mutation operator, and the tests run against it the way they would
 * run against a student's submission with that bug. A test's failure message on such a variant is
 * what a student who made that mistake would read, which the template's stubs cannot show.
 *
 * Variants are derived from the solution and its difference to the template alone, in source order,
 * so the same exercise always yields the same variants. No variant changes a `static void main`,
 * which tests rarely run, and no two variants yield the same source text. Operators work on the
 * token stream of the Java lexer, which keeps string literals and comments as tokens of their own,
 * so no variant changes text inside a string or a comment.
 */

export const MUTATION_OPERATORS = [
  "negate-conditional",
  "relational-boundary",
  "return-value",
  "logical-operator",
  "remove-call",
  "negate-condition",
  "arithmetic",
  "increment",
  "remove-negation",
  "boolean-literal",
  "remove-assignment",
] as const;

/** Classic operators, in the order a method's variants take them when there are few to choose. */
export type MutationOperator = (typeof MUTATION_OPERATORS)[number];

export interface Mutant {
  /** `V1`, `V2`, … in source order. */
  id: string;
  /** The solution file it changes. */
  path: string;
  /** The method it changes, as `Type.method`. */
  method: string;
  line: number;
  operator: MutationOperator;
  /** The source range replaced, in UTF-16 offsets of the file. */
  start: number;
  end: number;
  replacement: string;
  /** Where and how the variant differs from the solution, for raters. */
  description: string;
}

/** At most this many variants per exercise: enough to reach most tests, few enough to stay quick. */
export const MUTANT_LIMIT = 16;

/** Lines of each solution file a student writes: the lines the solution adds to the template. */
export function changedLines(diff: DiffFile[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const file of diff.filter((candidate) => candidate.change !== "removed")) {
    const lines = new Set<number>();
    for (const line of file.hunks.flatMap((hunk) => hunk.lines)) {
      if (line.kind === "added" && line.new !== undefined) lines.add(line.new);
    }
    if (lines.size > 0) result.set(file.path, lines);
  }
  return result;
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** The index of each delimiter's partner, in both directions. */
function delimiterPairs(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "operator") return;
    if (OPENERS[token.value] !== undefined) {
      open.push(index);
    } else if (token.value === ")" || token.value === "]" || token.value === "}") {
      const partner = open.pop();
      if (partner !== undefined) {
        pairs.set(partner, index);
        pairs.set(index, partner);
      }
    }
  });
  return pairs;
}

const TYPE_ARGUMENT_TOKENS = new Set([".", ",", "?", "[", "]", "&", "extends", "super"]);

/**
 * The `<` and `>` tokens that delimit type arguments rather than compare: after `.` (explicit type
 * arguments), a diamond, or a capitalised type name followed by a balanced list of type tokens.
 */
function typeArgumentBrackets(tokens: Token[]): Set<number> {
  const brackets = new Set<number>();
  tokens.forEach((token, index) => {
    if (token.value !== "<" || token.kind !== "operator" || brackets.has(index)) return;
    const previous = tokens[index - 1];
    const typeName = previous?.kind === "identifier" && /^[A-Z]/.test(previous.value);
    if (!(previous?.value === "." || typeName)) return;
    const opened = [index];
    for (let next = index + 1; next < tokens.length; next += 1) {
      const candidate = tokens[next] as Token;
      if (candidate.value === "<") {
        opened.push(next);
      } else if (candidate.value === ">") {
        brackets.add(opened.pop() as number);
        brackets.add(next);
        if (opened.length === 0) return;
      } else if (
        candidate.kind !== "identifier" &&
        !(candidate.kind === "keyword" && /^[a-z]+$/.test(candidate.value)) &&
        !TYPE_ARGUMENT_TOKENS.has(candidate.value)
      ) {
        for (const bracket of opened) brackets.delete(bracket);
        return;
      }
    }
  });
  return brackets;
}

const OPERAND_END = new Set(["identifier", "number", "string", "character"]);
const VALUE_KEYWORDS = new Set(["this", "true", "false", "null", "super"]);

/** Whether the token before an operator ends an operand, which makes `+` and `-` binary. */
function endsOperand(token: Token | undefined): boolean {
  if (token === undefined) return false;
  if (OPERAND_END.has(token.kind)) return true;
  if (token.kind === "keyword") return VALUE_KEYWORDS.has(token.value);
  return token.value === ")" || token.value === "]";
}

const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<="]);
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const NEGATED: Record<string, string> = {
  "==": "!=",
  "!=": "==",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};
const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };
const ARITHMETIC: Record<string, string> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
  "%": "*",
  "+=": "-=",
  "-=": "+=",
  "*=": "/=",
  "/=": "*=",
  "%=": "*=",
};

/** A value of the method's return type that differs from what it returns, or null for none. */
export function replacementValue(returnType: string, expression: string): string | null {
  const plain = expression.replaceAll(/\s+/g, "");
  const pick = (value: string, other: string) => (plain === value ? other : value);
  switch (returnType) {
    case "boolean":
    case "Boolean":
      return plain === "true" || plain === "false" ? null : `!(${expression})`;
    case "int":
    case "short":
    case "byte":
    case "Integer":
      return pick("0", "1");
    case "long":
    case "Long":
      return pick("0L", "1L");
    case "double":
    case "Double":
      return pick("0.0", "1.0");
    case "float":
    case "Float":
      return pick("0.0f", "1.0f");
    case "char":
      return "(char) 0";
    case "String":
      return pick('""', "null");
    case "Optional":
      return plain.startsWith("Optional.empty(") ? null : "java.util.Optional.empty()";
    case "List":
    case "ArrayList":
    case "Collection":
    case "Iterable":
      return "new java.util.ArrayList<>()";
    case "Set":
    case "HashSet":
      return "new java.util.HashSet<>()";
    case "Map":
    case "HashMap":
      return "new java.util.HashMap<>()";
    case "void":
      return null;
    default:
      return plain === "null" ? null : "null";
  }
}

/** The simple name of a method's declared return type, or null for a constructor. */
function returnTypeOf(tokens: Token[], nameIndex: number): string | null {
  let index = nameIndex - 1;
  if (tokens[index]?.value === "]") return "array";
  if (tokens[index]?.value === ">") {
    let depth = 0;
    for (; index >= 0; index -= 1) {
      const value = tokens[index]?.value;
      if (value === ">") depth += 1;
      if (value === "<") depth -= 1;
      if (depth === 0) break;
    }
    index -= 1;
  }
  const token = tokens[index];
  if (token === undefined) return null;
  if (token.kind === "identifier" || (token.kind === "keyword" && /^[a-z]+$/.test(token.value))) {
    return [
      "public",
      "protected",
      "private",
      "static",
      "final",
      "abstract",
      "synchronized",
    ].includes(token.value)
      ? null
      : token.value;
  }
  return null;
}

interface Site {
  operator: MutationOperator;
  start: number;
  end: number;
  replacement: string;
  line: number;
}

const QUIET_CALLS = /^System\.(out|err)\./;

const MAIN_MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "synchronized",
]);

/** Whether the method named at `nameIndex` is a `static void main`, which tests rarely run. */
export function staticMain(tokens: Token[], nameIndex: number): boolean {
  if (tokens[nameIndex]?.value !== "main" || tokens[nameIndex - 1]?.value !== "void") return false;
  for (let index = nameIndex - 2; MAIN_MODIFIERS.has(tokens[index]?.value ?? ""); index -= 1) {
    if (tokens[index]?.value === "static") return true;
  }
  return false;
}

const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record"]);

/**
 * Whether the `{` at `brace` opens the body of a class, interface, enum or record: a type keyword
 * and the type's name come before it in the same declaration, outside parentheses.
 */
function typeBody(tokens: Token[], brace: number): boolean {
  let depth = 0;
  for (let index = brace - 1; index >= 0; index -= 1) {
    const value = (tokens[index] as Token).value;
    if (value === ")") depth += 1;
    else if (value === "(") depth -= 1;
    else if (depth === 0 && (value === ";" || value === "{" || value === "}")) return false;
    // The type's name follows, unlike in `Foo.class` or a variable named `record`.
    else if (depth === 0 && TYPE_KEYWORDS.has(value) && tokens[index + 1]?.kind === "identifier") {
      return true;
    }
  }
  return false;
}

/**
 * Fields a file declares `final`, whose assignments cannot be left out without the code failing to
 * compile. Only declarations in a type's body count: a `final` local of one method must not hide
 * the assignments of a field of the same name elsewhere, and leaving out a local's assignment does
 * not compile either, so that variant is discarded.
 */
export function finalNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  const open: string[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === "operator") {
      if (token.value === "{") open.push(typeBody(tokens, index) ? "type" : "{");
      else if (OPENERS[token.value] !== undefined) open.push(token.value);
      else if (token.value === ")" || token.value === "]" || token.value === "}") open.pop();
      return;
    }
    if (token.value !== "final" || open.at(-1) !== "type") return;
    // The declared name: the first identifier outside type arguments that `=`, `;` or `,` follows.
    let angles = 0;
    for (let next = index + 1; next < tokens.length; next += 1) {
      const value = (tokens[next] as Token).value;
      if (/^>+$/.test(value)) angles -= value.length;
      else if (value === "<") angles += 1;
      else if (value === "(" || value === "{" || value === ";") return;
      const after = tokens[next + 1]?.value ?? "";
      if (
        angles === 0 &&
        tokens[next]?.kind === "identifier" &&
        (after === "=" || after === ";" || after === ",")
      ) {
        names.add(value);
        return;
      }
    }
  });
  return names;
}

/** Every mutation site in one method body, on the lines a student writes. */
function methodSites(
  source: string,
  tokens: Token[],
  method: MethodDeclaration,
  lines: ReadonlySet<number>,
): Site[] {
  const bodyStart = method.bodyStart;
  if (bodyStart === null || method.bodyEnd === null) return [];
  const first = bodyStart + 1;
  const last = method.bodyEnd - 1;
  const pairs = delimiterPairs(tokens);
  const typeArguments = typeArgumentBrackets(tokens);
  const nameIndex = tokens.findLastIndex(
    (token, index) =>
      index < bodyStart &&
      token.value === method.name &&
      token.line === method.line &&
      tokens[index + 1]?.value === "(",
  );
  if (staticMain(tokens, nameIndex)) return [];
  const returnType = method.isConstructor ? null : returnTypeOf(tokens, nameIndex);
  const finals = finalNames(tokens);
  const sites: Site[] = [];
  const add = (operator: MutationOperator, from: Token, to: Token, replacement: string) => {
    if (lines.has(from.line) && source.slice(from.start, to.end) !== replacement) {
      sites.push({ operator, start: from.start, end: to.end, replacement, line: from.line });
    }
  };
  const text = (from: number, to: number) =>
    source.slice((tokens[from] as Token).start, (tokens[to] as Token).end);

  // Blocks of lambdas and anonymous classes, whose `return` belongs to another method.
  const nested: Array<[number, number]> = [];
  // Statement starts: the first token after `;`, `{`, `}` or `else`, outside any parentheses.
  const statementStarts = new Set<number>();
  const parentheses: number[] = [0];
  for (let index = first; index <= last; index += 1) {
    const token = tokens[index] as Token;
    const previous = tokens[index - 1];
    if (token.value === "{") {
      const close = pairs.get(index) ?? last;
      if (previous?.value === "->" || (previous?.value === ")" && anonymousClass(index))) {
        nested.push([index, close]);
      }
      parentheses.push(0);
    } else if (token.value === "}") {
      parentheses.pop();
    } else if (token.value === "(") {
      parentheses[parentheses.length - 1] = (parentheses.at(-1) ?? 0) + 1;
    } else if (token.value === ")") {
      parentheses[parentheses.length - 1] = (parentheses.at(-1) ?? 0) - 1;
    }
    if (
      parentheses.at(-1) === 0 &&
      (index === first ||
        [";", "{", "}", "else"].includes(previous?.value ?? "") ||
        (previous?.value === ")" &&
          ["if", "for", "while"].includes(tokens[(pairs.get(index - 1) ?? 0) - 1]?.value ?? "")))
    ) {
      statementStarts.add(index);
    }
  }
  function anonymousClass(brace: number): boolean {
    const open = pairs.get(brace - 1);
    if (open === undefined) return false;
    for (let index = open - 1; index >= first; index -= 1) {
      const value = tokens[index]?.value ?? "";
      if (value === "new") return true;
      if (!(tokens[index]?.kind === "identifier" || [".", "<", ">", ",", "?"].includes(value))) {
        return false;
      }
    }
    return false;
  }
  const insideNested = (index: number) =>
    nested.some(([open, close]) => index > open && index < close);
  /** The `;` that ends the statement starting at `from`, or -1. */
  const statementEnd = (from: number) => {
    for (let index = from; index <= last; index += 1) {
      const value = tokens[index]?.value;
      if (value === ";") return index;
      if (value === "(" || value === "[" || value === "{") index = pairs.get(index) ?? last;
      else if (value === ")" || value === "]" || value === "}") return -1;
    }
    return -1;
  };

  for (let index = first; index <= last; index += 1) {
    const token = tokens[index] as Token;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const value = token.value;
    if (token.kind === "operator") {
      const adjacentAngle =
        (previous?.value === ">" && previous.end === token.start) ||
        ((next?.value === ">" || next?.value === ">=") && next.start === token.end);
      const comparison = COMPARISONS.has(value) && !typeArguments.has(index) && !adjacentAngle;
      if (comparison) {
        add("negate-conditional", token, token, NEGATED[value] as string);
        if (BOUNDARY[value] !== undefined) {
          add("relational-boundary", token, token, BOUNDARY[value]);
        }
      } else if (value === "&&" || value === "||") {
        add("logical-operator", token, token, value === "&&" ? "||" : "&&");
      } else if (value === "++" || value === "--") {
        add("increment", token, token, value === "++" ? "--" : "++");
      } else if (value === "!") {
        add("remove-negation", token, token, "");
      } else if (ARITHMETIC[value] !== undefined) {
        const binary = value.endsWith("=") || endsOperand(previous);
        const concatenation =
          value.startsWith("+") && (previous?.kind === "string" || next?.kind === "string");
        if (binary && !concatenation) add("arithmetic", token, token, ARITHMETIC[value] as string);
      }
    } else if (value === "true" || value === "false") {
      add("boolean-literal", token, token, value === "true" ? "false" : "true");
    } else if (value === "return" && token.kind === "keyword" && returnType !== null) {
      const end = statementEnd(index + 1);
      if (end > index + 1 && !insideNested(index)) {
        const expression = text(index + 1, end - 1);
        const replacement = replacementValue(returnType, expression);
        if (replacement !== null) {
          add("return-value", next as Token, tokens[end - 1] as Token, replacement);
        }
      }
    } else if (value === "if" && next?.value === "(") {
      const close = pairs.get(index + 1);
      if (close !== undefined && close > index + 2) {
        const condition = tokens.slice(index + 2, close);
        const compares = condition.some(
          (inner, offset) => COMPARISONS.has(inner.value) && !typeArguments.has(index + 2 + offset),
        );
        if (!compares && condition[0]?.value !== "!") {
          const inner = text(index + 2, close - 1);
          add(
            "negate-condition",
            tokens[index + 2] as Token,
            tokens[close - 1] as Token,
            `!(${inner})`,
          );
        }
      }
    }
    if (statementStarts.has(index)) {
      const end = statementEnd(index);
      if (end > index) {
        const statement = tokens.slice(index, end);
        const target = value === "this" && next?.value === "." ? 2 : 0;
        const assigned = statement[target];
        const assigns =
          assigned?.kind === "identifier" && ASSIGNMENTS.has(statement[target + 1]?.value ?? "");
        if (assigns) {
          // Leaving out the assignment of a `final` field does not compile.
          if (!finals.has(assigned.value)) {
            add("remove-assignment", token, tokens[end] as Token, ";");
          }
        } else if (callStatement(index, end) && !QUIET_CALLS.test(text(index, end))) {
          add("remove-call", token, tokens[end] as Token, ";");
        }
      }
    }
  }
  /** A statement that is only a call: a chain of names and calls, ending in a call. */
  function callStatement(from: number, end: number): boolean {
    const start = tokens[from] as Token;
    if (!(
      start.kind === "identifier" ||
      (start.value === "this" && tokens[from + 1]?.value === ".")
    )) {
      return false;
    }
    let calls = 0;
    for (let index = from; index < end; index += 1) {
      const token = tokens[index] as Token;
      if (token.value === "(") {
        calls += 1;
        index = pairs.get(index) ?? end;
      } else if (!(token.kind === "identifier" || token.value === "." || token.value === "this")) {
        return false;
      }
    }
    return calls > 0 && tokens[end - 1]?.value === ")";
  }
  return sites;
}

const SHOWN = 120;

function clip(text: string): string {
  return text.length > SHOWN ? `${text.slice(0, SHOWN - 1)}…` : text;
}

/**
 * The source lines a range touches, whitespace runs collapsed, cut to a window around the range when
 * they are long, so the change itself is always in view.
 */
function linesAround(source: string, start: number, end: number): string {
  const from = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  const collapse = (text: string) => text.replaceAll(/\s+/g, " ");
  const head = collapse(source.slice(from, start)).trimStart();
  const text =
    `${head}${collapse(source.slice(start, newline === -1 ? undefined : newline))}`.trimEnd();
  if (text.length <= SHOWN) return text;
  const left = Math.max(0, Math.min(head.length - SHOWN / 2, text.length - SHOWN));
  return `${left > 0 ? "…" : ""}${text.slice(left, left + SHOWN)}${left + SHOWN < text.length ? "…" : ""}`;
}

function describe(source: string, path: string, method: string, site: Site): string {
  const where = `Line ${site.line} of ${path.split("/").at(-1)} (${method.split(".").at(-1)})`;
  const original = source.slice(site.start, site.end).replaceAll(/\s+/g, " ").trim();
  if (site.operator === "remove-call" || site.operator === "remove-assignment") {
    return `${where}: \`${clip(original)}\` left out`;
  }
  if (site.operator === "return-value") {
    return `${where}: returns \`${clip(site.replacement)}\` instead of \`${clip(original)}\``;
  }
  const before = linesAround(source, site.start, site.end);
  const mutated = `${source.slice(0, site.start)}${site.replacement}${source.slice(site.end)}`;
  const after = linesAround(mutated, site.start, site.start + site.replacement.length);
  return `${where}: \`${before}\` became \`${after}\``;
}

type Candidate = Omit<Mutant, "id">;

/**
 * The variants of a solution: every site on the lines it adds to the template, then a deterministic
 * pick of at most `limit` that spreads over methods first and over operators within a method, so
 * every method a student writes gets variants before any method gets a second one. A site whose
 * changed source is the same as an earlier site's is dropped: the two would be one variant.
 */
export function generateMutants(
  solution: SourceFile[],
  diff: DiffFile[],
  limit = MUTANT_LIMIT,
): Mutant[] {
  const changed = changedLines(diff);
  const methods: Candidate[][] = [];
  const sources = new Set<string>();
  for (const file of [...solution].sort((left, right) => left.path.localeCompare(right.path))) {
    const lines = changed.get(file.path);
    if (lines === undefined || !file.path.endsWith(".java")) continue;
    const unit = analyseJavaUnit(file.path, file.content);
    for (const method of unit.methods) {
      const name = `${method.typeName ?? ""}.${method.name}`.replace(/^\./, "");
      const sites = methodSites(file.content, unit.tokens, method, lines);
      // Within a method: each operator's first site, then each operator's second, and so on, with
      // sites on a token another variant already changes moved behind the rest.
      const byOperator = MUTATION_OPERATORS.map((operator) =>
        sites.filter((site) => site.operator === operator),
      );
      const rounds = Math.max(0, ...byOperator.map((group) => group.length));
      const ordered: Site[] = [];
      for (let round = 0; round < rounds; round += 1) {
        for (const group of byOperator) {
          const site = group[round];
          if (site !== undefined) ordered.push(site);
        }
      }
      const seen = new Set<number>();
      const fresh: Site[] = [];
      const repeated: Site[] = [];
      for (const site of ordered) {
        (seen.has(site.start) ? repeated : fresh).push(site);
        seen.add(site.start);
      }
      const candidates = [...fresh, ...repeated]
        .filter((site) => {
          const mutated = `${file.path}\0${file.content.slice(0, site.start)}${site.replacement}${file.content.slice(site.end)}`;
          if (sources.has(mutated)) return false;
          sources.add(mutated);
          return true;
        })
        .map((site) => ({
          path: file.path,
          method: name,
          line: site.line,
          operator: site.operator,
          start: site.start,
          end: site.end,
          replacement: site.replacement,
          description: describe(file.content, file.path, name, site),
        }));
      if (candidates.length > 0) methods.push(candidates);
    }
  }
  const picked: Candidate[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    const before = picked.length;
    for (const candidates of methods) {
      const candidate = candidates[round];
      if (candidate !== undefined && picked.length < limit) picked.push(candidate);
    }
    if (picked.length === before) break;
  }
  return picked
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.start - right.start ||
        MUTATION_OPERATORS.indexOf(left.operator) - MUTATION_OPERATORS.indexOf(right.operator),
    )
    .map((candidate, index) => ({ id: `V${index + 1}`, ...candidate }));
}

/** The solution's files with one variant applied. */
export function applyMutant(files: BundleFile[], mutant: Mutant): BundleFile[] {
  return files.map((file) => {
    if (file.path !== mutant.path) return file;
    const content = `${file.content.slice(0, mutant.start)}${mutant.replacement}${file.content.slice(mutant.end)}`;
    return { path: file.path, content, bytes: new TextEncoder().encode(content).byteLength };
  });
}

export interface MutantResult {
  mutant: Mutant;
  /**
   * Caught: a test reported failure. Survived: the complete original test set passed.
   * Discarded: the variant did not compile. Timed-out or incomplete builds are unmeasured,
   * because an infrastructure failure must not be counted as a detected code change.
   */
  status: "caught" | "survived" | "discarded" | "timed_out" | "incomplete";
  failures: TestCaseResult[];
}

/**
 * A variant's outcome. A reported test failure is evidence of rejection even when later tests
 * are missing. A partial all-passing report is incomplete, never an accepted variant.
 */
function resultOf(mutant: Mutant, build: SubmissionBuild, expected: string[]): MutantResult {
  if (!build.compiled) {
    return { mutant, status: "discarded", failures: [] };
  }
  const reported = new Set(build.test_cases.map((testCase) => testCase.name));
  const failures = build.test_cases.filter((testCase) => !testCase.passed);
  if (
    !build.tests_executed ||
    build.test_cases.length === 0 ||
    expected.some((name) => !reported.has(name))
  ) {
    return { mutant, status: failures.length > 0 ? "caught" : "incomplete", failures };
  }
  return { mutant, status: failures.length > 0 ? "caught" : "survived", failures };
}

export interface MutationRunOptions {
  /** The tests the solution's build reported; a variant's report must have every one. */
  expected: string[];
  /** Builds running at once; each build tests two variants one after the other. */
  concurrency?: number;
  /**
   * A build that takes longer is stopped. A build of two variants that times out runs each again
   * alone; a variant whose build times out alone remains unmeasured.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Build and test every variant with the backend that built the exercise. A build has a template and
 * a solution lane, so each build carries two variants, one per lane; a lone last variant shares its
 * build with the template. Variants that do not compile are discarded. When a build of two variants
 * times out, either may loop forever, so each runs again alone, with the template in the other lane;
 * a variant that times out alone remains unmeasured. Any other failure of the backend stops the
 * exercise's build.
 */
export async function runMutants(
  backend: BuildBackend,
  job: BuildJob,
  mutants: Mutant[],
  options: MutationRunOptions,
): Promise<MutantResult[]> {
  const pairs: Array<[Mutant, Mutant | undefined]> = [];
  for (let index = 0; index < mutants.length; index += 2) {
    pairs.push([mutants[index] as Mutant, mutants[index + 1]]);
  }
  const results: MutantResult[][] = Array.from({ length: pairs.length }, () => []);
  const signal = options.signal ?? new AbortController().signal;
  const solution = job.bundle.solution;
  /** One build of the two lanes, or null when it timed out. */
  const attempt = async (
    template: BundleFile[],
    lane: BundleFile[],
  ): Promise<BuildOutcome | null> => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000);
    try {
      return await backend.build(
        {
          request: job.request,
          analysis: false,
          bundle: { ...job.bundle, template, solution: lane },
        },
        AbortSignal.any([signal, timeout]),
      );
    } catch (error) {
      if (signal.aborted || !timeout.aborted) throw error;
      return null;
    }
  };
  const alone = async (mutant: Mutant): Promise<MutantResult> => {
    const outcome = await attempt(job.bundle.template, applyMutant(solution, mutant));
    return outcome === null
      ? { mutant, status: "timed_out", failures: [] }
      : resultOf(mutant, outcome.solution, options.expected);
  };
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const index = next;
      next += 1;
      const [first, second] = pairs[index] as [Mutant, Mutant | undefined];
      if (second === undefined) {
        results[index] = [await alone(first)];
        continue;
      }
      const outcome = await attempt(applyMutant(solution, first), applyMutant(solution, second));
      results[index] =
        outcome === null
          ? [await alone(first), await alone(second)]
          : [
              resultOf(first, outcome.template, options.expected),
              resultOf(second, outcome.solution, options.expected),
            ];
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, pairs.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.flat();
}

/** How much a failure message tells a student: their own words, an assertion, an exception, nothing. */
export function messageRank(message: string | undefined): number {
  const kind = failureKind(message);
  return kind === "own" ? 3 : kind === "bare" ? 2 : kind === "exception" ? 1 : 0;
}

/**
 * Identity hash codes and the names of generated classes differ from one JVM to the next. Without
 * them a rebuild yields the same exercise, which it must, since a changed exercise is refused.
 */
export function stableMessage(message: string): string {
  return message
    .replaceAll(/\$\$Lambda[/$][\w./$]*/g, () => "$$Lambda")
    .replaceAll(/\b([A-Za-z_$][\w$]*)@[0-9a-f]{1,8}\b/g, "$1@…");
}

export interface MutationAnalysis {
  selected?: number;
  discarded?: number;
  unresolved?: number;
  /** Variants that compiled and ran the tests. */
  ran: number;
  /** Variants at least one test failed. */
  caught: number;
  /** Variants every test passed. */
  survivors: Mutant[];
  /** Per test, the most telling message a variant failed it with, and that variant. */
  failures: Map<string, { message: string; mutant: Mutant }>;
}

/** The words of a camel-case or snake-case name, in lower case: `testCountActive` is test, count, active. */
function words(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

/** Whether a test's name has the method's name as whole words, in sequence: `lend` is not in `Lending`. */
function namesMethod(test: string, method: string): boolean {
  const wanted = words(method);
  const have = words(test);
  if (wanted.length === 0) return false;
  for (let start = 0; start + wanted.length <= have.length; start += 1) {
    if (wanted.every((word, offset) => have[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Pick, for every test, the message of the variant whose bug the test most likely targets. The most
 * telling message comes first: a message the test wrote itself over a bare expected/actual assertion
 * over an exception. Among equally telling ones, a variant that changes a method the test's name
 * names, as whole words, comes first; then the variant that fails the fewest tests, because its bug
 * is the one this test singles out; then the earliest variant.
 */
export function analyseMutants(results: MutantResult[]): MutationAnalysis {
  const failures = new Map<
    string,
    { message: string; mutant: Mutant; named: boolean; rank: number; breadth: number }
  >();
  for (const result of results) {
    const breadth = result.failures.length;
    const method = result.mutant.method.split(".").at(-1) ?? "";
    for (const failure of result.failures) {
      const message = stableMessage(failure.message?.trim() ?? "");
      const named = namesMethod(failure.name, method);
      const rank = messageRank(message);
      const best = failures.get(failure.name);
      if (
        best === undefined ||
        rank > best.rank ||
        (rank === best.rank &&
          ((named && !best.named) || (named === best.named && breadth < best.breadth)))
      ) {
        failures.set(failure.name, { message, mutant: result.mutant, named, rank, breadth });
      }
    }
  }
  return {
    selected: results.length,
    discarded: results.filter((r) => r.status === "discarded").length,
    unresolved: results.filter((r) => r.status === "timed_out" || r.status === "incomplete").length,
    ran: results.filter((result) => result.status === "caught" || result.status === "survived")
      .length,
    caught: results.filter((result) => result.status === "caught").length,
    survivors: results
      .filter((result) => result.status === "survived")
      .map((result) => result.mutant),
    failures: new Map(
      [...failures].map(([name, { message, mutant }]) => [name, { message, mutant }]),
    ),
  };
}
