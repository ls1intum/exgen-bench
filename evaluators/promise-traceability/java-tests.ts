/**
 * A length-preserving pair of views over one Java source. Structure is scanned on `code`, where
 * comment and literal bodies are blanked, so a brace, parenthesis or `//` inside a string can never
 * be read as structure. Offsets index both views, so a match found in `code` recovers its original
 * text from `raw`.
 */
export interface JavaSpan {
  code: string;
  raw: string;
}

interface JavaSource extends JavaSpan {
  /** Every string literal and text block body, in source order, comments excluded. */
  strings: string[];
}

export interface TestMethod {
  file: string;
  name: string;
  body: JavaSpan;
  assertions: number;
}

export interface TestSuiteModel {
  behaviouralMethods: TestMethod[];
  structuralMethods: TestMethod[];
  structuralFiles: string[];
  behavioural: JavaSource;
  assertThrownTypes: string[];
  stringLiterals: string[];
  numberLiterals: number[];
}

const TEST_ANNOTATION = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g;
const ASSERTION_CALL = /\b(?:assert[A-Z]\w*|fail)\s*\(/g;
const METHOD_TAIL = /^\s*(?:throws\s[\w.,\s]+)?$/;
const STRUCTURAL_PROVIDER = /\bextends\s+(?:Class|Method|Attribute|Constructor)TestProvider\b/;
const THROWN_TYPE =
  /\bassert(?:Throws(?:Exactly)?|InstanceOf)\s*\(\s*([\w.]+)\.class|\binstanceof\s+([\w.]*[A-Z]\w*(?:Exception|Error))\b/g;
// Java numeric literals: hexadecimal, underscore separators, exponents and a width suffix.
const NUMBER_LITERAL =
  /(?<![\w.])-?(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[lLfFdD]?(?![\w.])/g;

function readJava(raw: string): JavaSource {
  let code = "";
  const strings: string[] = [];
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) {
      code += raw[cursor] === "\n" ? "\n" : " ";
    }
  };

  while (index < raw.length) {
    if (raw.startsWith("//", index)) {
      const newline = raw.indexOf("\n", index);
      const end = newline < 0 ? raw.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (raw.startsWith("/*", index)) {
      const close = raw.indexOf("*/", index + 2);
      const end = close < 0 ? raw.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (raw.startsWith('"""', index)) {
      const close = raw.indexOf('"""', index + 3);
      const body = close < 0 ? raw.length : close;
      strings.push(raw.slice(index + 3, body));
      blank(index, close < 0 ? raw.length : close + 3);
      index = close < 0 ? raw.length : close + 3;
      continue;
    }
    const quote = raw[index];
    if (quote === '"' || quote === "'") {
      let cursor = index + 1;
      // A literal cannot span a line, so an unterminated one ends at the newline rather than
      // swallowing the rest of the file.
      while (cursor < raw.length && raw[cursor] !== quote && raw[cursor] !== "\n") {
        cursor += raw[cursor] === "\\" ? 2 : 1;
      }
      const end = Math.min(cursor, raw.length);
      code += quote;
      blank(index + 1, end);
      if (quote === '"') {
        strings.push(raw.slice(index + 1, end));
      }
      if (raw[end] === quote) {
        code += quote;
        index = end + 1;
      } else {
        index = end;
      }
      continue;
    }
    code += raw[index];
    index += 1;
  }
  return { code, raw, strings };
}

/** Index of the delimiter closing the one at `openIndex`, or the end of the source. */
export function matchBalanced(code: string, openIndex: number, close: string): number {
  const open = code[openIndex] ?? "";
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    const character = code[index];
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return code.length;
}

export function span(source: JavaSpan, start: number, end: number): JavaSpan {
  return { code: source.code.slice(start, end), raw: source.raw.slice(start, end) };
}

/** String literals inside a span, recovered from `raw` at the offsets `code` blanked. */
export function stringLiteralsIn(source: JavaSpan): string[] {
  return [...source.code.matchAll(/"( *)"/g)].map((match) => {
    const start = (match.index ?? 0) + 1;
    return source.raw.slice(start, start + (match[1]?.length ?? 0));
  });
}

export function identifierLiterals(strings: readonly string[]): string[] {
  return strings
    .filter((literal) => /^[A-Za-z_][\w.$]*$/.test(literal))
    .flatMap((literal) => literal.split(/[.$]/));
}

function numberValue(literal: string): number {
  const separated = literal.replace(/_/g, "");
  return Number(separated.replace(/^0[xX]/.test(separated) ? /[lL]$/ : /[lLfFdD]$/, ""));
}

function methodHeader(code: string, from: number): { name: string; open: number } | undefined {
  const calls = /\b([A-Za-z_]\w*)\s*\(/g;
  calls.lastIndex = from;
  for (let call = calls.exec(code); call !== null; call = calls.exec(code)) {
    const name = call[1];
    if (name === undefined) {
      continue;
    }
    const parameters = matchBalanced(code, call.index + call[0].length - 1, ")");
    const brace = code.indexOf("{", parameters);
    if (brace < 0) {
      return undefined;
    }
    // Only a method header reaches its body with nothing but a `throws` clause in between. Anything
    // else — an annotation with arguments, a nested call — is skipped and the scan continues.
    if (METHOD_TAIL.test(code.slice(parameters + 1, brace))) {
      return { name, open: brace };
    }
    calls.lastIndex = parameters + 1;
  }
  return undefined;
}

function testMethods(file: string, source: JavaSource): TestMethod[] {
  const methods: TestMethod[] = [];
  const seen = new Set<number>();
  for (const annotation of source.code.matchAll(TEST_ANNOTATION)) {
    const header = methodHeader(source.code, annotation.index);
    if (header === undefined || seen.has(header.open)) {
      continue;
    }
    seen.add(header.open);
    const body = span(source, header.open + 1, matchBalanced(source.code, header.open, "}"));
    methods.push({
      file,
      name: header.name,
      body,
      assertions: [...body.code.matchAll(ASSERTION_CALL)].length,
    });
  }
  return methods;
}

export function parseTestSuite(files: Array<{ path: string; text: string }>): TestSuiteModel {
  const behaviouralMethods: TestMethod[] = [];
  const structuralMethods: TestMethod[] = [];
  const structuralFiles: string[] = [];
  const behavioural: JavaSource = { code: "", raw: "", strings: [] };

  for (const file of files) {
    const source = readJava(file.text);
    const methods = testMethods(file.path, source);
    if (STRUCTURAL_PROVIDER.test(source.code)) {
      structuralFiles.push(file.path);
      structuralMethods.push(...methods);
      continue;
    }
    behavioural.code += `${source.code}\n`;
    behavioural.raw += `${source.raw}\n`;
    behavioural.strings.push(...source.strings);
    behaviouralMethods.push(...methods);
  }

  const assertThrownTypes = new Set<string>();
  for (const match of behavioural.code.matchAll(THROWN_TYPE)) {
    const qualified = match[1] ?? match[2];
    if (qualified !== undefined) {
      assertThrownTypes.add(qualified.split(".").pop() ?? qualified);
    }
  }
  const numberLiterals = new Set<number>();
  for (const match of behavioural.code.matchAll(NUMBER_LITERAL)) {
    const value = numberValue(match[0]);
    if (Number.isFinite(value)) {
      numberLiterals.add(value);
    }
  }

  return {
    behaviouralMethods,
    structuralMethods,
    structuralFiles,
    behavioural,
    assertThrownTypes: [...assertThrownTypes],
    stringLiterals: [...new Set(behavioural.strings)],
    numberLiterals: [...numberLiterals],
  };
}
