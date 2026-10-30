import type { BundleFile } from "../../kit/bundle.ts";
import { analyseJavaFiles } from "../../kit/bundle.ts";
import { matchBalanced, parseTestSuite } from "../promise-traceability/java-tests.ts";

/**
 * Item-writing flaws that rules detect more reliably than a rater: evaluation design v2 assigns them to
 * Tier 1 so that neither the judge nor the expert is asked about them. Each detector is lexical and
 * reports its findings as evidence, so its precision can be checked by reading them.
 */

export interface FlawFinding {
  file: string;
  detail: string;
}

export interface FlawReport {
  /** Assertion calls in behavioural tests, the denominator of `assertionsWithoutMessage`. */
  assertions: number;
  assertionsWithoutMessage: FlawFinding[];
  exactFloatAssertions: FlawFinding[];
  replayedExamples: FlawFinding[];
  undefinedLabels: FlawFinding[];
}

/**
 * Arguments a JUnit 5 assertion takes before its optional message. A call with more arguments whose
 * last one is a string or a message supplier carries a message; `assertEquals(1.0, x, 1e-9)` has
 * three arguments and no message, because the third is a delta.
 */
const BASE_ARITY: Record<string, number> = {
  fail: 0,
  assertTrue: 1,
  assertFalse: 1,
  assertNull: 1,
  assertNotNull: 1,
  assertDoesNotThrow: 1,
  assertEquals: 2,
  assertNotEquals: 2,
  assertSame: 2,
  assertNotSame: 2,
  assertArrayEquals: 2,
  assertIterableEquals: 2,
  assertLinesMatch: 2,
  assertThrows: 2,
  assertThrowsExactly: 2,
  assertInstanceOf: 2,
  assertTimeout: 2,
  assertTimeoutPreemptively: 2,
};

const ASSERTION_CALL = /\b(assert[A-Z]\w*|fail)\s*\(/g;
const FLOAT_LITERAL = /^-?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[dDfF]?$/;
/** What makes a numeric literal a `double` or `float`: a decimal point, an exponent or a suffix. */
const FLOATING_POINT_MARK = /[.eE]|[dDfF]$/;
const LITERAL_CALL = /\b([a-z][A-Za-z0-9_]*)\s*\(([^()]*)\)/g;
const LITERAL = /"[^"]*"|'[^']*'|(?<![\w.])-?\d[\d_.]*[lLdDfF]?(?![\w])/;
const LABEL = String.raw`[A-Z]{1,2}\d{1,2}`;
const TODO_LABEL = new RegExp(String.raw`\bTODO\b\s*\(?(${LABEL})\b`, "g");
/** `R7: the address needs an @`; the space after the separator keeps data such as `A1:B2` out. */
const LEADING_LABEL = new RegExp(String.raw`^\s*[\[(]?(${LABEL})[\])]?\s*[:\-–]\s`);
const CODE_SPAN = /`((?:[^`\n]|\n(?![ \t]*\n)){1,200})`/g;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;

/** Top-level arguments of a call whose parentheses span `[open, close]` in blanked code. */
function argumentsOf(code: string, open: number, close: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const character = code[index];
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      ranges.push([start, index]);
      start = index + 1;
    }
  }
  if (code.slice(start, close).trim() !== "" || ranges.length > 0) {
    ranges.push([start, close]);
  }
  return ranges;
}

/** Whether an argument is a failure message: a string expression or a message supplier. */
function isMessage(code: string): boolean {
  return code.includes('"') || /^\s*\(\s*\)\s*->/.test(code) || /message|msg/i.test(code);
}

/** `sum( 4, 5 )` and `sum(4,5)` are one call; `new int[]` keeps its space. */
function normaliseCall(name: string, args: string): string {
  const compact = args
    .replace(/\s+/g, " ")
    .replace(/\s*([(),[\]{}])\s*/g, "$1")
    .trim();
  return `${name}(${compact})`;
}

function methodName(call: string): string {
  return call.slice(0, call.indexOf("("));
}

/**
 * Calls with at least one literal argument and nothing that looks like a declaration. For Java
 * source, `code` is `text` with comments and string contents blanked at the same offsets, so a call
 * quoted in a comment or a failure message is not read as one, while the arguments come from `text`.
 */
function literalCalls(text: string, code = text): string[] {
  const calls: string[] = [];
  for (const match of code.matchAll(LITERAL_CALL)) {
    const name = match[1];
    const end = match.index + match[0].length - 1;
    const args = text.slice(end - (match[2] ?? "").length, end);
    if (name === undefined || !LITERAL.test(args)) {
      continue;
    }
    // `int sum(int a, int b)` declares a method; an example call has no type before an argument.
    if (/(?:^|,)\s*[A-Za-z_][\w<>[\]]*\s+[A-Za-z_]\w*\s*(?:,|$)/.test(args)) {
      continue;
    }
    calls.push(normaliseCall(name, args));
  }
  return calls;
}

function statementExamples(statement: string): Set<string> {
  const examples = new Set<string>();
  for (const match of statement.matchAll(FENCED_BLOCK)) {
    for (const call of literalCalls(match[1] ?? "")) {
      examples.add(call);
    }
  }
  const withoutBlocks = statement.replace(FENCED_BLOCK, " ");
  for (const match of withoutBlocks.matchAll(CODE_SPAN)) {
    for (const call of literalCalls((match[1] ?? "").replace(/\s+/g, " "))) {
      examples.add(call);
    }
  }
  return examples;
}

function mentions(statement: string, label: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${label}(?![0-9])`).test(statement);
}

export function findFlaws(input: {
  statement: string;
  template: BundleFile[];
  solution: BundleFile[];
  tests: BundleFile[];
}): FlawReport {
  const suite = parseTestSuite(
    input.tests
      .filter((file) => file.path.endsWith(".java"))
      .map((file) => ({ path: file.path, text: file.content })),
  );
  const report: FlawReport = {
    assertions: 0,
    assertionsWithoutMessage: [],
    exactFloatAssertions: [],
    replayedExamples: [],
    undefinedLabels: [],
  };
  // Only a call to a method the exercise declares is an input. `List.of(1, 2, 3)` in the statement
  // shows an expected value, and a test that builds the same value replays nothing.
  const declaredMethods = new Set(
    analyseJavaFiles([...input.template, ...input.solution]).units.flatMap((unit) =>
      unit.methods.map((method) => method.name),
    ),
  );
  const examples = new Set(
    [...statementExamples(input.statement)].filter((call) => declaredMethods.has(methodName(call))),
  );
  const exampleMethods = new Set([...examples].map(methodName));

  for (const method of suite.behaviouralMethods) {
    const { code, raw } = method.body;
    const where = `${method.file}#${method.name}`;
    for (const call of code.matchAll(ASSERTION_CALL)) {
      const name = call[1] ?? "";
      const base = BASE_ARITY[name];
      if (base === undefined) {
        continue;
      }
      report.assertions += 1;
      const open = (call.index ?? 0) + call[0].length - 1;
      const close = matchBalanced(code, open, ")");
      const args = argumentsOf(code, open, close);
      const last = args.at(-1);
      const lastCode = last === undefined ? "" : code.slice(last[0], last[1]);
      const hasMessage = args.length > base && isMessage(lastCode);
      if (!hasMessage) {
        report.assertionsWithoutMessage.push({ file: where, detail: `${name} without a message` });
      }
      if (
        (name === "assertEquals" || name === "assertNotEquals") &&
        (args.length === 2 || (args.length === 3 && hasMessage))
      ) {
        const compared = args.slice(0, 2).map(([from, to]) => raw.slice(from, to).trim());
        if (
          compared.some((value) => FLOAT_LITERAL.test(value) && FLOATING_POINT_MARK.test(value))
        ) {
          report.exactFloatAssertions.push({
            file: where,
            detail: `${name}(${compared.join(", ")}) compares floating-point values without a delta`,
          });
        }
      }
    }
    const calls = literalCalls(raw, code).filter((value) => exampleMethods.has(methodName(value)));
    if (calls.length > 0 && calls.every((value) => examples.has(value))) {
      report.replayedExamples.push({
        file: where,
        detail: `only replays the worked example ${[...new Set(calls)].join(", ")}`,
      });
    }
  }

  const labels = new Map<string, string>();
  for (const unit of analyseJavaFiles(input.template).units) {
    for (const comment of unit.comments) {
      for (const match of comment.value.matchAll(TODO_LABEL)) {
        if (match[1] !== undefined && !labels.has(match[1])) {
          labels.set(match[1], unit.path);
        }
      }
    }
  }
  for (const literal of suite.stringLiterals) {
    const label = LEADING_LABEL.exec(literal)?.[1];
    if (label !== undefined && !labels.has(label)) {
      labels.set(label, "test messages");
    }
  }
  for (const [label, file] of [...labels].sort(([left], [right]) => left.localeCompare(right))) {
    if (!mentions(input.statement, label)) {
      report.undefinedLabels.push({
        file,
        detail: `the label ${label} is used but the statement never defines it`,
      });
    }
  }
  return report;
}
