export interface TestMethod {
  file: string;
  name: string;
  body: string;
  assertions: number;
}

export interface TestSuiteModel {
  behaviouralMethods: TestMethod[];
  structuralMethods: TestMethod[];
  structuralFiles: string[];
  behaviouralSource: string;
  assertThrownTypes: string[];
  stringLiterals: string[];
  numberLiterals: number[];
}

const TEST_ANNOTATION = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g;
const METHOD_HEADER = /([A-Za-z_]\w*)\s*\([^()]*\)\s*(?:throws\s[\w.,\s]+)?\{/g;
export const ASSERTION_CALL = /\b(?:assert[A-Z]\w*|fail)\s*\(/g;
const STRUCTURAL_PROVIDER = /\bextends\s+(?:Class|Method|Attribute|Constructor)TestProvider\b/;

export function stripComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      output += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      output += character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          output += source[index] ?? "";
          index += 1;
        }
        output += source[index] ?? "";
        index += 1;
      }
      output += quote;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

export function maskStringLiterals(source: string): string {
  return source.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (literal) => `${literal[0]}${" ".repeat(literal.length - 2)}${literal[0]}`,
  );
}

export function identifierLiterals(source: string): string[] {
  return [...source.matchAll(/"([A-Za-z_][\w.$]*)"/g)].flatMap((match) =>
    (match[1] ?? "").split(/[.$]/),
  );
}

function blockAt(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  return source.slice(openIndex + 1);
}

function testMethods(file: string, code: string): TestMethod[] {
  const methods: TestMethod[] = [];
  const seen = new Set<number>();
  TEST_ANNOTATION.lastIndex = 0;
  for (const annotation of code.matchAll(TEST_ANNOTATION)) {
    METHOD_HEADER.lastIndex = annotation.index;
    const header = METHOD_HEADER.exec(code);
    if (header?.[1] === undefined || seen.has(header.index)) {
      continue;
    }
    seen.add(header.index);
    const body = blockAt(code, header.index + header[0].length - 1);
    ASSERTION_CALL.lastIndex = 0;
    methods.push({
      file,
      name: header[1],
      body,
      assertions: [...body.matchAll(ASSERTION_CALL)].length,
    });
  }
  return methods;
}

export function parseTestSuite(files: Array<{ path: string; text: string }>): TestSuiteModel {
  const behaviouralMethods: TestMethod[] = [];
  const structuralMethods: TestMethod[] = [];
  const structuralFiles: string[] = [];
  const behaviouralSources: string[] = [];

  for (const file of files) {
    const code = stripComments(file.text);
    const methods = testMethods(file.path, code);
    if (STRUCTURAL_PROVIDER.test(code)) {
      structuralFiles.push(file.path);
      structuralMethods.push(...methods);
      continue;
    }
    behaviouralSources.push(code);
    behaviouralMethods.push(...methods);
  }

  const behaviouralSource = behaviouralSources.join("\n");
  const assertThrownTypes = new Set<string>();
  for (const match of behaviouralSource.matchAll(
    /\bassert(?:Throws(?:Exactly)?|InstanceOf)\s*\(\s*([\w.]+)\.class|\binstanceof\s+([\w.]*[A-Z]\w*(?:Exception|Error))\b/g,
  )) {
    const qualified = match[1] ?? match[2];
    if (qualified !== undefined) {
      assertThrownTypes.add(qualified.split(".").pop() ?? qualified);
    }
  }
  const stringLiterals = new Set<string>();
  for (const match of behaviouralSource.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (match[1] !== undefined) {
      stringLiterals.add(match[1]);
    }
  }
  const numberLiterals = new Set<number>();
  for (const match of behaviouralSource.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) {
    numberLiterals.add(Number(match[0]));
  }

  return {
    behaviouralMethods,
    structuralMethods,
    structuralFiles,
    behaviouralSource,
    assertThrownTypes: [...assertThrownTypes],
    stringLiterals: [...stringLiterals],
    numberLiterals: [...numberLiterals],
  };
}
