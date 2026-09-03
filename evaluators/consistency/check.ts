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

/**
 * The inline spans of a problem statement that actually name code.
 *
 * Backticks in a problem statement carry two unrelated jobs: naming an API, and emphasising an
 * ordinary word - "the list is `empty`", "the `first` element". Only the first is a claim about the
 * artifacts, so only the first can be ungrounded. Treating every span as a code reference makes
 * almost all of them ungrounded, which drowns the real signal rather than measuring it.
 *
 * A span counts as code when it carries a structural marker - a call, a member access, an array, a
 * type argument, a parameter list - or when a single token is cased like a Java name. That admits
 * `EvenSum.sumEven(int[] values)`, `LandVehicle`, `getSpeed()` and `List<String>`, and declines
 * `empty`, `first` and `You`.
 *
 * The trade is deliberate and one-directional: a single lowercase word that really is a method name,
 * `size`, is not checked. A missed check costs a finding nobody sees; a false finding costs the
 * metric its meaning.
 */
function statementCodeSpans(statement: string): string[] {
  const prose = withoutNonCodeRegions(statement);
  const spans: string[] = [];
  for (const match of prose.matchAll(CODE_SPAN)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0) {
      spans.push(value);
    }
  }
  return spans;
}

/**
 * The statement without the regions whose contents are not the exercise's own code.
 *
 * A UML diagram's keywords and Artemis's task markup are neither prose nor API references; they are
 * a different language embedded in the document, and every word in them would be reported as
 * ungrounded.
 */
function withoutNonCodeRegions(statement: string): string {
  return statement
    .replace(/@startuml[\s\S]*?@enduml/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[task\]\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/%[a-zA-Z]+%/g, " ");
}

/** Whether a code span names code rather than emphasising a word. */
function namesCode(span: string): boolean {
  if (/[.()\[\]<>;=]|::/.test(span)) {
    return true;
  }
  // A single token is a name only when it is cased like one: PascalCase or camelCase, never a word.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(span) && /[a-z][A-Z]|^[A-Z][a-z]*[A-Z]/.test(span);
}

/**
 * Every identifier-shaped word in a code span, so `EvenSum.sumEven(int[] values)` yields four:
 * `EvenSum`, `sumEven`, `int` and `values`. The caller drops the ones that are Java built-ins.
 *
 * String and character literals are removed first. A worked example writes `Book("Dune", "Fiction")`,
 * where `Dune` is the datum the example is about, not a name the artifacts must declare - reading
 * inside the quotes turns every example value into a missing identifier.
 *
 * Single characters go too. `f(a, b)` says nothing checkable about the code, and a one-letter name
 * collides with too much to be evidence either way.
 */
function identifiersInSpan(span: string): string[] {
  const withoutLiterals = span.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  return [...withoutLiterals.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .map((match) => match[0])
    .filter((word) => word.length > 1 && IDENTIFIER.test(word));
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
  // Keywords a statement uses when describing a design, none of which the artifacts "declare".
  "abstract",
  "extends",
  "implements",
  "interface",
  "enum",
  "record",
  "instanceof",
  "super",
  "this",
  "import",
  "package",
  "sealed",
  "permits",
  // Every Java type inherits these, so a statement may name one without any artifact declaring it.
  "toString",
  "equals",
  "hashCode",
  "getClass",
  "compareTo",
  // The template's own markers live in comments, which a Java tokenizer does not emit as
  // identifiers - so a statement telling a student to complete the `TODO`s reads as ungrounded.
  "TODO",
]);

export function checkConsistency(bundle: CandidateBundle): ConsistencyReport {
  const residuals: ConsistencyResidual[] = [];
  const codeIdentifiers = new Set([
    ...collectIdentifiers(bundle.solution),
    ...collectIdentifiers(bundle.template),
    ...collectIdentifiers(bundle.tests),
  ]);
  const spans = statementCodeSpans(bundle.statement);
  // Only the spans that name code can be ungrounded. The value checks below read every span,
  // because `-1` is a claim about behaviour even though it names nothing.
  const statementIdentifiers = [
    ...new Set(
      spans
        .filter((span) => namesCode(span))
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
