import type { BundleFile, CandidateBundle } from "../../kit/bundle.ts";
import { analyseJavaFiles } from "../../kit/bundle.ts";
import { type Construct, detectConstructs } from "../java-static/spec.ts";

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

/**
 * An inline code span. CommonMark lets a span continue over one line ending, rendered as a space, but
 * not across a blank line. A pattern that stops at every newline skips such a span and pairs its
 * closing backtick with the next span's opening one, so the prose between two spans is read as code.
 */
const CODE_SPAN = /`((?:[^`\n]|\n(?![ \t]*\n)){1,120})`/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INTEGER = /^-?\d{1,9}$/;

/**
 * A span shaped like a package, `de.tum.cit.aet.exercise`, optionally followed by a type. Three or
 * more lowercase segments keep member chains such as `list.size` out; JDK packages are not the
 * artifacts' to declare. `namedPackage` decides whether the span really names a package.
 */
const PACKAGE_REFERENCE =
  /^(?!java\.|javax\.|jdk\.|this\.|super\.)([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,})(?:\.([A-Z][A-Za-z0-9_$]*))?$/;

/**
 * A variable a worked example declares inside the statement, such as `r1` in
 * `boolean r1 = b.reserve();`. It belongs to the example, not to the artifacts. A declaration after
 * a modifier, `private static final int CAPACITY = 10`, is a field the artifacts must declare,
 * and stays checked.
 */
const LOCAL_DECLARATION =
  /(?<!\b(?:public|protected|private|static|final)\s+)\b(?:var|[A-Za-z_$][A-Za-z0-9_$]*(?:<[^<>]*>)?(?:\[\])*)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g;

/** A fully qualified JDK name, `java.util.List`; none of its parts is the artifacts' to declare. */
const JDK_QUALIFIED_NAME = /\b(?:java|javax|jdk)(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)+/g;

/** A JDK type followed by a member chain, `System.out.println` or `String.endsWith`. */
const MEMBER_CHAIN = /\b([A-Z][A-Za-z0-9_$]*)((?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)+)/g;

/**
 * English words that sit between the words of a sentence and are never Java tokens. A span with
 * several words, one of them from this list, is expected output or a sentence fragment such as
 * `Dune by Frank Herbert (ISBN 123)`, not an API reference. Java keywords (`for`, `if`) and
 * plausible one-letter names (`a`) are left out, so code is not mistaken for prose.
 */
const PROSE_WORDS = new Set([
  "an",
  "and",
  "are",
  "at",
  "by",
  "from",
  "in",
  "into",
  "is",
  "not",
  "of",
  "on",
  "or",
  "than",
  "the",
  "then",
  "to",
  "was",
  "when",
  "with",
]);

/**
 * JDK types a statement may use as the receiver of a hint, `Math.max` or `String.endsWith`. Such a
 * chain points at the JDK and is not checked. A JDK type named on its own still is: a statement that
 * promises an `IllegalArgumentException` no artifact throws disagrees with the artifacts.
 */
const JDK_TYPES = new Set([
  "ArithmeticException",
  "ArrayDeque",
  "ArrayIndexOutOfBoundsException",
  "ArrayList",
  "Arrays",
  "BiFunction",
  "Byte",
  "Character",
  "CharSequence",
  "ClassCastException",
  "Collection",
  "Collections",
  "Collectors",
  "Comparable",
  "Comparator",
  "ConcurrentModificationException",
  "Consumer",
  "Deque",
  "Error",
  "Exception",
  "Float",
  "Function",
  "HashMap",
  "HashSet",
  "IllegalArgumentException",
  "IllegalStateException",
  "IndexOutOfBoundsException",
  "IntStream",
  "IOException",
  "Iterable",
  "Iterator",
  "LinkedHashMap",
  "LinkedHashSet",
  "LinkedList",
  "LocalDate",
  "LocalDateTime",
  "Math",
  "NoSuchElementException",
  "NullPointerException",
  "Number",
  "NumberFormatException",
  "Objects",
  "Optional",
  "Predicate",
  "PriorityQueue",
  "Queue",
  "Random",
  "RuntimeException",
  "Scanner",
  "Short",
  "Stream",
  "StringBuilder",
  "Supplier",
  "System",
  "Throwable",
  "TreeMap",
  "TreeSet",
  "UnsupportedOperationException",
]);

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
    const value = match[1]?.replace(/\s+/g, " ").trim();
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

/** Whether a code span names code rather than emphasising a word or quoting text. */
function namesCode(span: string): boolean {
  // A placeholder such as `<location>` stands for a value in expected output, not for code.
  if (
    /^\[[\s\S]*\]$/.test(span) ||
    // A bare local array value, such as items[0], does not name a promised API member.
    /^[a-z_$][\w$]*(?:\s*\[[^\]]+\])+\s*$/.test(span) ||
    /^[A-Z]\w*\[[^\]]*=[^\]]*\]$/.test(span) ||
    readsAsProse(span) ||
    /^<[a-z][a-z ]*>$/.test(span)
  ) {
    return false;
  }
  if (/[.()[\]<>;=]|::/.test(span)) {
    return true;
  }
  // A single token is a name only when it is cased like one: PascalCase or camelCase, never a word.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(span) && /[a-z][A-Z]|^[A-Z][a-z]*[A-Z]/.test(span);
}

function readsAsProse(span: string): boolean {
  const words = withoutLiterals(span).trim().split(/\s+/);
  return words.length > 1 && words.some((word) => PROSE_WORDS.has(word.toLowerCase()));
}

function withoutLiterals(span: string): string {
  return span.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

/**
 * The package a span names, and the type it qualifies if any. A span counts as a package only when
 * it starts where a declared package starts: `de.tum.cit.aet.exercise` in a bundle that declares
 * `de.tum.cit.aet.exgen.exercise` is a package, while `shelf.location.code` is a member chain and is
 * checked name by name like any other span.
 */
function namedPackage(
  span: string,
  packageRoots: Set<string>,
): { name: string; type: string | undefined } | undefined {
  const match = PACKAGE_REFERENCE.exec(span);
  const name = match?.[1];
  if (name === undefined || !packageRoots.has(name.split(".")[0] ?? "")) {
    return undefined;
  }
  return { name, type: match?.[2] };
}

/** Variables declared by the statement's own worked examples. */
function statementLocals(spans: string[]): Set<string> {
  const locals = new Set<string>();
  for (const span of spans) {
    for (const match of withoutLiterals(span).matchAll(LOCAL_DECLARATION)) {
      if (match[1] !== undefined) {
        locals.add(match[1]);
      }
    }
  }
  return locals;
}

/**
 * A JDK type used as the receiver of a member chain in this span, with every member reached through
 * it: `System.out.println` points at the JDK, so none of its parts is the artifacts' to declare.
 */
function jdkMembers(span: string): Set<string> {
  const members = new Set<string>();
  for (const match of withoutLiterals(span).matchAll(MEMBER_CHAIN)) {
    const receiver = match[1];
    if (receiver !== undefined && (JDK_TYPES.has(receiver) || JAVA_BUILTIN_WORDS.has(receiver))) {
      members.add(receiver);
      for (const name of (match[2] ?? "").split(".")) {
        if (name.trim() !== "") {
          members.add(name.trim());
        }
      }
    }
  }
  return members;
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
  const jdk = jdkMembers(span);
  const text = withoutLiterals(span).replace(JDK_QUALIFIED_NAME, " ");
  return [...text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .map((match) => match[0])
    .filter((word) => word.length > 1 && IDENTIFIER.test(word) && !jdk.has(word));
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
  // Control-flow keywords a statement names when it asks for a construct.
  "if",
  "else",
  "switch",
  "case",
  "default",
  "for",
  "while",
  "do",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "var",
  "yield",
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
  const declaredPackages = [
    ...new Set(
      [bundle.solution, bundle.template, bundle.tests]
        .flatMap((files) => analyseJavaFiles(files).units)
        .map((unit) => unit.packageName ?? ""),
    ),
  ];
  const packageRoots = new Set(declaredPackages.map((name) => name.split(".")[0] ?? ""));
  const spans = statementCodeSpans(bundle.statement);
  const locals = statementLocals(spans);
  // Only the spans that name code can be ungrounded. The value checks below read every span,
  // because `-1` is a claim about behaviour even though it names nothing. A package is compared as
  // a whole below, since its segments one by one would be found in a package that differs; only the
  // type it qualifies is checked here.
  const statementIdentifiers = [
    ...new Set(
      spans
        .filter((span) => namesCode(span))
        .flatMap((span) => {
          const named = namedPackage(span, packageRoots);
          if (named === undefined) {
            return identifiersInSpan(span);
          }
          return named.type === undefined ? [] : [named.type];
        })
        .filter((identifier) => !JAVA_BUILTIN_WORDS.has(identifier) && !locals.has(identifier)),
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

  const namedPackages = new Set(
    spans.flatMap((span) => namedPackage(span, packageRoots)?.name ?? []),
  );
  for (const name of [...namedPackages].sort()) {
    const declared = declaredPackages.some(
      (declaredPackage) => declaredPackage === name || declaredPackage.startsWith(`${name}.`),
    );
    if (!declared) {
      residuals.push({
        kind: "ungrounded_statement_identifier",
        detail: `the statement names the package \`${name}\`, which no generated artifact declares`,
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
