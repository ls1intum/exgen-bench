import { parseStatement, type ClaimKind, type StatementClaim } from "./statement.ts";
import {
  identifierLiterals,
  maskStringLiterals,
  parseTestSuite,
  type TestMethod,
  type TestSuiteModel,
} from "./java-tests.ts";
import type { SourceFile } from "./bundle.ts";

export interface ClaimTrace {
  kind: ClaimKind;
  detail: string | undefined;
  text: string;
  witnessed: boolean;
  witness: string;
}

export interface LiteralTrace {
  kind: "string" | "number";
  raw: string;
  text: string;
  witnessed: boolean;
}

export interface MemberTrace {
  name: string;
  referenced: boolean;
}

export interface TraceabilityReport {
  claims: ClaimTrace[];
  literals: LiteralTrace[];
  members: MemberTrace[];
  behaviouralMethods: number;
  structuralMethods: number;
  assertions: number;
  assertionlessMethods: string[];
  structuralLanePresent: boolean;
  unclassifiedNormativeUnits: string[];
}

const MUTATORS =
  /\.\s*(?:add|addAll|remove|removeAll|removeIf|set|setAll|put|putAll|clear|sort|replaceAll|append|insert|push|poll|offer)\s*\(/;
const EMPTY_VALUE =
  /\bList\.of\s*\(\s*\)|\bMap\.of\s*\(\s*\)|\bSet\.of\s*\(\s*\)|\bCollections\.empty\w+\s*\(\s*\)|new\s+\w+\s*<[^>]*>\s*\(\s*\)|new\s+\w+\s*\[\s*0\s*\]|""/;
const SEQUENCE_ASSERTION = /\bassert(?:IterableEquals|ArrayEquals|LinesMatch)\s*\(/;
const SEQUENCE_ARGUMENT = /^\s*(?:List\.of|Arrays\.asList|Set\.of|new\s+[\w<>]+\s*\[)/;
const IDENTIFIER = /\b[a-z_]\w*\b/g;
const ARGUMENT_NOISE = new Set(["new", "null", "true", "false", "this", "class", "return"]);

function argumentsAt(text: string, openIndex: number): { start: number; end: number } {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { start: openIndex + 1, end: index };
      }
    }
  }
  return { start: openIndex + 1, end: text.length };
}

const PLATFORM_RECEIVER =
  /\b(?:List|Map|Set|Arrays|Collections|Optional|String|Objects|Stream|IntStream|Integer|Double|Long|Boolean|Math|Assertions|Assert|System|Files|Paths|ReflectionTestUtils)\s*\.\s*$/;
const REFLECTION_HELPER =
  /\b(?:invokeMethod|getMethod|getConstructor|getAttribute|newInstance|forName|getDeclaredMethod|getDeclaredField)\s*\(/;

interface Analysed {
  code: string;
  raw: string;
}

function analysed(raw: string): Analysed {
  return { code: maskStringLiterals(raw), raw };
}

function slice(text: Analysed, start: number, end: number): Analysed {
  return { code: text.code.slice(start, end), raw: text.raw.slice(start, end) };
}

function memberCallAt(code: string, index: number, apiMembers: Set<string>, name: string): boolean {
  return (
    apiMembers.has(name) && !PLATFORM_RECEIVER.test(code.slice(Math.max(0, index - 40), index))
  );
}

function callsMember(text: Analysed, apiMembers: Set<string>): boolean {
  for (const call of text.code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = call[1];
    if (
      name !== undefined &&
      call.index !== undefined &&
      memberCallAt(text.code, call.index, apiMembers, name)
    ) {
      return true;
    }
  }
  return (
    REFLECTION_HELPER.test(text.code) &&
    identifierLiterals(text.raw).some((literal) => apiMembers.has(literal))
  );
}

function resultIdentifiers(text: Analysed, apiMembers: Set<string>): Set<string> {
  const identifiers = new Set<string>();
  for (const assignment of text.code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*[^;]+;/g)) {
    const name = assignment[1];
    if (name === undefined || assignment.index === undefined) {
      continue;
    }
    const start = assignment.index + assignment[0].indexOf("=") + 1;
    if (callsMember(slice(text, start, assignment.index + assignment[0].length - 1), apiMembers)) {
      identifiers.add(name);
    }
  }
  return identifiers;
}

function inputPreservationWitness(methods: TestMethod[], apiMembers: string[]): string | undefined {
  const callable = new Set(apiMembers);
  for (const method of methods) {
    if (method.assertions === 0) {
      continue;
    }
    const text = analysed(method.body);
    for (const call of text.code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const name = call[1];
      if (name === undefined || call.index === undefined) {
        continue;
      }
      const open = call.index + call[0].length - 1;
      if (!memberCallAt(text.code, call.index, callable, name)) {
        continue;
      }
      const passed = argumentsAt(text.code, open);
      IDENTIFIER.lastIndex = 0;
      const identifiers = [...text.code.slice(passed.start, passed.end).matchAll(IDENTIFIER)]
        .map((match) => match[0])
        .filter((identifier) => !ARGUMENT_NOISE.has(identifier));
      const after = text.code.slice(passed.end);
      for (const identifier of identifiers) {
        const token = new RegExp(`\\b${identifier}\\b`);
        for (const assertion of after.matchAll(/\b(?:assert[A-Z]\w*)\s*\(/g)) {
          if (assertion.index === undefined) {
            continue;
          }
          const checked = argumentsAt(after, assertion.index + assertion[0].length - 1);
          if (token.test(after.slice(checked.start, checked.end))) {
            return `${method.name} asserts on '${identifier}' after ${name}(...)`;
          }
        }
        if (new RegExp(`\\b${identifier}\\s*${MUTATORS.source}`).test(after)) {
          return `${method.name} mutates '${identifier}' after ${name}(...) and still asserts`;
        }
      }
    }
  }
  return undefined;
}

function assertionOnResultWitness(
  methods: TestMethod[],
  apiMembers: string[],
  assertion: string,
): string | undefined {
  const callable = new Set(apiMembers);
  const pattern = new RegExp(`\\b${assertion}\\s*\\(`, "g");
  for (const method of methods) {
    const text = analysed(method.body);
    const results = resultIdentifiers(text, callable);
    for (const call of text.code.matchAll(pattern)) {
      if (call.index === undefined) {
        continue;
      }
      const checked = argumentsAt(text.code, call.index + call[0].length - 1);
      if (callsMember(slice(text, checked.start, checked.end), callable)) {
        return `${method.name} applies ${assertion} to a call under test`;
      }
      const scope = text.code.slice(checked.start, checked.end);
      for (const result of results) {
        if (new RegExp(`\\b${result}\\b`).test(scope)) {
          return `${method.name} applies ${assertion} to '${result}'`;
        }
      }
    }
  }
  return undefined;
}

function orderingWitness(methods: TestMethod[]): string | undefined {
  for (const method of methods) {
    const code = maskStringLiterals(method.body);
    const positions = new Set<string>();
    for (const assertion of code.matchAll(/\b(?:assert[A-Z]\w*)\s*\(/g)) {
      if (assertion.index === undefined) {
        continue;
      }
      const span = argumentsAt(code, assertion.index + assertion[0].length - 1);
      const checked = code.slice(span.start, span.end);
      if (SEQUENCE_ASSERTION.test(assertion[0]) || SEQUENCE_ARGUMENT.test(checked)) {
        return `${method.name} compares a whole sequence`;
      }
      for (const access of checked.matchAll(
        /\.\s*get\s*\(\s*([\w+\-* ]+?)\s*\)|\[\s*([\w+\-* ]+?)\s*\]/g,
      )) {
        const position = (access[1] ?? access[2] ?? "").trim();
        if (position !== "") {
          positions.add(position);
        }
      }
    }
    if (positions.size >= 2 || [...positions].some((position) => !/^\d+$/.test(position))) {
      return `${method.name} asserts on element positions ${[...positions].slice(0, 4).join(", ")}`;
    }
  }
  return undefined;
}

function nullRejectionWitness(methods: TestMethod[], apiMembers: string[]): string | undefined {
  const alternation = apiMembers
    .slice(0, 128)
    .map((member) => member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (alternation === "") {
    return undefined;
  }
  const rejection = new RegExp(
    `\\b(?:${alternation})\\s*\\(\\s*(?:\\([\\w.<>\\[\\], ]+\\)\\s*)?null\\s*[,)]`,
  );
  for (const method of methods) {
    const code = maskStringLiterals(method.body);
    if (/\bassertThrows/.test(code) && rejection.test(code)) {
      return `${method.name} asserts a member under test rejects null`;
    }
  }
  return undefined;
}

function witnessFor(
  claim: StatementClaim,
  suite: TestSuiteModel,
  apiMembers: string[],
): { witnessed: boolean; witness: string } {
  const found = (witness: string) => ({ witnessed: true, witness });
  const missing = (witness: string) => ({ witnessed: false, witness });

  switch (claim.kind) {
    case "non_null_result": {
      const asserted =
        assertionOnResultWitness(suite.behaviouralMethods, apiMembers, "assertNotNull") ??
        nullRejectionWitness(suite.behaviouralMethods, apiMembers);
      return asserted === undefined
        ? missing("no assertNotNull on a result of the member under test, and no null rejection")
        : found(asserted);
    }
    case "nullable_result": {
      const asserted = assertionOnResultWitness(suite.behaviouralMethods, apiMembers, "assertNull");
      return asserted === undefined
        ? missing("no assertNull on a result of the member under test")
        : found(asserted);
    }
    case "no_mutation": {
      const preserved = inputPreservationWitness(suite.behaviouralMethods, apiMembers);
      return preserved === undefined
        ? missing("no assertion re-reads an argument after the call under test")
        : found(preserved);
    }
    case "exception": {
      const type = claim.detail ?? "";
      return suite.assertThrownTypes.includes(type)
        ? found(`assertThrows(${type}.class, ...)`)
        : missing(`no assertThrows for ${type}`);
    }
    case "ordering": {
      const ordered = orderingWitness(suite.behaviouralMethods);
      return ordered === undefined
        ? missing("no assertion compares a sequence or its element positions")
        : found(ordered);
    }
    case "immutability": {
      if (suite.assertThrownTypes.includes("UnsupportedOperationException")) {
        return found("assertThrows(UnsupportedOperationException.class, ...)");
      }
      const copied = inputPreservationWitness(suite.behaviouralMethods, apiMembers);
      return copied === undefined
        ? missing("no rejection of a mutating call and no defensive-copy assertion")
        : found(copied);
    }
    case "empty_input": {
      const method = suite.behaviouralMethods.find(
        (candidate) => candidate.assertions > 0 && EMPTY_VALUE.test(candidate.body),
      );
      return method === undefined
        ? missing("no asserting test constructs an empty input")
        : found(`${method.name} asserts on an empty input`);
    }
  }
}

export function trace(problemStatement: string, testFiles: SourceFile[]): TraceabilityReport {
  const statement = parseStatement(problemStatement);
  const suite = parseTestSuite(testFiles);
  const referenced = new Set([
    ...[...maskStringLiterals(suite.behaviouralSource).matchAll(/\b[A-Za-z_]\w*\b/g)].map(
      (match) => match[0],
    ),
    ...identifierLiterals(suite.behaviouralSource),
  ]);

  return {
    claims: statement.claims.map((claim) => ({
      kind: claim.kind,
      detail: claim.detail,
      text: claim.text,
      ...witnessFor(claim, suite, statement.apiMembers),
    })),
    literals: statement.literals.map((literal) => ({
      kind: literal.kind,
      raw: literal.raw,
      text: literal.text,
      witnessed:
        literal.kind === "string"
          ? suite.stringLiterals.some((found) => found.includes(String(literal.value)))
          : suite.numberLiterals.includes(Number(literal.value)),
    })),
    members: statement.apiMembers.map((name) => ({ name, referenced: referenced.has(name) })),
    behaviouralMethods: suite.behaviouralMethods.length,
    structuralMethods: suite.structuralMethods.length,
    assertions: suite.behaviouralMethods.reduce((total, method) => total + method.assertions, 0),
    assertionlessMethods: suite.behaviouralMethods
      .filter((method) => method.assertions === 0)
      .map((method) => `${method.file}#${method.name}`),
    structuralLanePresent: suite.structuralFiles.length > 0,
    unclassifiedNormativeUnits: statement.unclassifiedNormativeUnits,
  };
}
