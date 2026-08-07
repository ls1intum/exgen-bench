import type { BundleFile, CandidateBundle } from "../shared/bundle.ts";
import { analyseJavaFiles } from "../shared/bundle.ts";
import { detectConstructs, type Construct } from "../java-static/spec.ts";

/**
 * Cross-artifact consistency: does the problem statement describe the artifacts that were generated?
 *
 * The output is a set of named, independently reportable residual classes rather than one score, for
 * two reasons. A count that cannot be broken down is not actionable in a paper. And a different
 * implementation of the same check -- a structured-output model call, say -- is then a different
 * producer of the *same* residual classes rather than a different metric.
 *
 * Nothing here calls a model.
 */

export type ResidualKind =
  | "ungrounded_statement_identifier"
  | "unmentioned_public_api"
  | "contradicted_construct"
  | "unsupported_statement_value";

export interface ConsistencyResidual {
  kind: ResidualKind;
  detail: string;
}

export interface ConsistencyReport {
  residuals: ConsistencyResidual[];
  counts: Record<ResidualKind, number>;
  /** Identifiers the statement referred to in code spans, for auditability. */
  statementIdentifiers: string[];
}

const CODE_SPAN = /`([^`\n]{1,120})`/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INTEGER = /^-?\d{1,9}$/;

/**
 * Statement prose mapped onto the same closed construct vocabulary the java-static evaluator uses,
 * so a statement that demands a construct can be checked against the code that was generated. The
 * phrasings are English and Artemis-flavoured; a statement in another language matches nothing and
 * produces no residual, which under-reports rather than over-reports.
 */
const CONSTRUCT_PHRASES: Array<{ construct: Construct; required: RegExp; forbidden: RegExp }> = [
  {
    construct: "loop",
    required: /\buse\s+(?:a\s+)?\*{0,2}loops?\*{0,2}\b/i,
    forbidden: /\b(?:do\s+not|don't|never|avoid)\s+use\s+(?:a\s+)?\*{0,2}loops?\*{0,2}\b/i,
  },
  {
    construct: "recursion",
    required:
      /\buse\s+\*{0,2}recursion\*{0,2}\b|\brecursive(?:ly)?\s+(?:solution|implementation)\b/i,
    forbidden: /\b(?:do\s+not|don't|never|avoid)\s+use\s+\*{0,2}recursion\*{0,2}\b/i,
  },
  {
    construct: "stream_api",
    required: /\buse\s+(?:the\s+)?\*{0,2}stream\s*api\*{0,2}\b|\buse\s+\*{0,2}streams?\*{0,2}\b/i,
    forbidden:
      /\b(?:do\s+not|don't|never|avoid)\s+use\s+(?:the\s+)?\*{0,2}stream\s*api\*{0,2}\b|\b(?:do\s+not|don't|never|avoid)\s+use\s+\*{0,2}streams?\*{0,2}\b/i,
  },
  {
    construct: "switch",
    required: /\buse\s+(?:a\s+)?\*{0,2}switch\b/i,
    forbidden: /\b(?:do\s+not|don't|never|avoid)\s+use\s+(?:a\s+)?\*{0,2}switch\b/i,
  },
  {
    construct: "try_catch",
    required: /\buse\s+(?:a\s+)?\*{0,2}try[-/ ]?catch\b/i,
    forbidden: /\b(?:do\s+not|don't|never|avoid)\s+use\s+(?:a\s+)?\*{0,2}try[-/ ]?catch\b/i,
  },
];

function collectIdentifiers(files: BundleFile[]): Set<string> {
  const identifiers = new Set<string>();
  const { units } = analyseJavaFiles(files);
  for (const unit of units) {
    for (const token of unit.tokens) {
      if (token.kind === "identifier") {
        identifiers.add(token.value);
      }
    }
  }
  return identifiers;
}

function statementCodeSpans(statement: string): string[] {
  const spans: string[] = [];
  for (const match of statement.matchAll(CODE_SPAN)) {
    const value = match[1];
    if (value !== undefined) {
      spans.push(value.trim());
    }
  }
  return spans;
}

/**
 * Every identifier-shaped word in a code span, so `EvenSum.sumEven(int[] values)` yields four:
 * `EvenSum`, `sumEven`, `int` and `values`. The caller drops the ones that are Java built-ins.
 */
function identifiersInSpan(span: string): string[] {
  return [...span.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .map((match) => match[0])
    .filter((word) => IDENTIFIER.test(word));
}

const JAVA_BUILTIN_WORDS = new Set([
  "int",
  "long",
  "short",
  "byte",
  "char",
  "boolean",
  "float",
  "double",
  "void",
  "String",
  "Integer",
  "Long",
  "Double",
  "Boolean",
  "Object",
  "List",
  "Map",
  "Set",
  "null",
  "true",
  "false",
  "new",
  "return",
  "public",
  "private",
  "static",
  "final",
  "class",
  "throws",
]);

export function checkConsistency(bundle: CandidateBundle): ConsistencyReport {
  const residuals: ConsistencyResidual[] = [];
  const codeIdentifiers = new Set([
    ...collectIdentifiers(bundle.solution),
    ...collectIdentifiers(bundle.template),
    ...collectIdentifiers(bundle.tests),
  ]);
  const spans = statementCodeSpans(bundle.statement);
  const statementIdentifiers = [
    ...new Set(
      spans
        .flatMap((span) => identifiersInSpan(span))
        .filter((identifier) => !JAVA_BUILTIN_WORDS.has(identifier)),
    ),
  ].sort();

  for (const identifier of statementIdentifiers) {
    if (!codeIdentifiers.has(identifier)) {
      residuals.push({
        kind: "ungrounded_statement_identifier",
        detail: `the statement refers to \`${identifier}\`, which appears in no generated artifact`,
      });
    }
  }

  // The reverse direction is a weaker signal -- a legitimate helper type produces a residual -- so
  // it is reported as a class of its own rather than folded into the one above.
  const { units } = analyseJavaFiles(bundle.solution);
  const statementText = bundle.statement;
  for (const unit of units) {
    for (const type of unit.types) {
      if (!statementText.includes(type.name)) {
        residuals.push({
          kind: "unmentioned_public_api",
          detail: `the solution declares ${type.kind} ${type.name}, which the statement never names`,
        });
      }
    }
  }

  const constructs = detectConstructs(units);
  for (const phrase of CONSTRUCT_PHRASES) {
    // Test the prohibition first: "do not use a loop" also matches "use a loop".
    if (phrase.forbidden.test(statementText)) {
      if (constructs.has(phrase.construct)) {
        residuals.push({
          kind: "contradicted_construct",
          detail: `the statement forbids ${phrase.construct}, and the solution uses it`,
        });
      }
      continue;
    }
    if (phrase.required.test(statementText) && !constructs.has(phrase.construct)) {
      residuals.push({
        kind: "contradicted_construct",
        detail: `the statement requires ${phrase.construct}, and the solution does not use it`,
      });
    }
  }

  // Integer values the statement puts in a code span should be observable somewhere in the tests:
  // a statement that promises `-1` for an empty input and a suite that never mentions -1 disagree.
  const testTokens = analyseJavaFiles(bundle.tests).units.flatMap((unit) => unit.tokens);
  const testLiterals = new Set<string>();
  testTokens.forEach((token, index) => {
    if (token.kind !== "number") {
      return;
    }
    const value = token.value.replace(/[_lLfFdD]/g, "");
    testLiterals.add(value);
    if (testTokens[index - 1]?.value === "-") {
      testLiterals.add(`-${value}`);
    }
  });
  // Distinct values, not distinct mentions: a statement that repeats `-1` in its summary and again
  // in its requirement list disagrees with the tests once, not twice.
  for (const trimmed of [...new Set(spans.map((span) => span.trim()))].sort()) {
    if (!INTEGER.test(trimmed)) {
      continue;
    }
    if (!testLiterals.has(trimmed)) {
      residuals.push({
        kind: "unsupported_statement_value",
        detail: `the statement specifies the value \`${trimmed}\`, which no test asserts`,
      });
    }
  }

  const counts: Record<ResidualKind, number> = {
    ungrounded_statement_identifier: 0,
    unmentioned_public_api: 0,
    contradicted_construct: 0,
    unsupported_statement_value: 0,
  };
  for (const residual of residuals) {
    counts[residual.kind] += 1;
  }
  return { residuals, counts, statementIdentifiers };
}
