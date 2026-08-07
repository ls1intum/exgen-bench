/**
 * A Java lexer, complete for Java 21 lexical syntax: comments, text blocks, escapes, numeric
 * literals with underscores, and the full operator set.
 *
 * A full Java parser is the wrong dependency for a measurement instrument a reviewer has to be able
 * to read, so this lexer plus the brace-level structure recovery in `structure.ts` stands in for
 * one. What that substitution costs is recorded in the `structure.ts` header.
 */

export type TokenKind =
  | "identifier"
  | "keyword"
  | "number"
  | "string"
  | "character"
  | "operator"
  | "comment";

export interface Token {
  kind: TokenKind;
  value: string;
  /** Source offset of the first character, in UTF-16 code units. */
  start: number;
  /** One past the last character. */
  end: number;
  line: number;
}

export const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "void",
  "volatile",
  "while",
  // Literals are keywords for every purpose these evaluators have.
  "true",
  "false",
  "null",
]);

// No `>` is merged with the `>` after it, so `>>`, `>>>` and their assignment forms are absent.
// Java closes nested type arguments with adjacent `>` (JLS 21 §3.12), so a shift operator and the
// tail of `Map<String, List<Integer>>` are the same characters; keeping them apart is what lets a
// type argument list be balanced by counting. Nothing downstream reads a shift.
const OPERATORS = [
  "<<=",
  "...",
  "->",
  "::",
  "++",
  "--",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "!",
  "~",
  "?",
  ":",
  "&",
  "|",
  "^",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  ",",
  ".",
  "@",
];

const MAXIMUM_SOURCE_BYTES = 4 * 1024 * 1024;

function isIdentifierStart(character: string): boolean {
  return /[\p{L}_$]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[\p{L}\p{Nd}_$]/u.test(character);
}

export interface TokenizeResult {
  tokens: Token[];
  /** Comments are kept separately: no metric counts them, and every metric must ignore them. */
  comments: Token[];
}

export function tokenizeJava(source: string): TokenizeResult {
  if (source.length > MAXIMUM_SOURCE_BYTES) {
    throw new Error(`Java source exceeds ${MAXIMUM_SOURCE_BYTES} characters`);
  }
  const tokens: Token[] = [];
  const comments: Token[] = [];
  let index = 0;
  let line = 1;

  const push = (kind: TokenKind, start: number, end: number, tokenLine = line): void => {
    const token: Token = { kind, value: source.slice(start, end), start, end, line: tokenLine };
    if (kind === "comment") {
      comments.push(token);
    } else {
      tokens.push(token);
    }
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const start = index;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      push("comment", start, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") {
          line += 1;
        }
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`unterminated block comment opened on line ${startLine}`);
      }
      index += 2;
      push("comment", start, index, startLine);
      continue;
    }
    if (character === '"' && source[index + 1] === '"' && source[index + 2] === '"') {
      const start = index;
      const startLine = line;
      index += 3;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"' && source[index + 1] === '"' && source[index + 2] === '"') {
          index += 3;
          break;
        }
        if (source[index] === "\n") {
          line += 1;
        }
        index += 1;
      }
      if (index > source.length) {
        throw new Error(`unterminated text block opened on line ${startLine}`);
      }
      push("string", start, index, startLine);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
        }
        if (source[index] === "\n") {
          throw new Error(`unterminated literal on line ${line}`);
        }
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`unterminated literal on line ${line}`);
      }
      index += 1;
      push(quote === '"' ? "string" : "character", start, index);
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const start = index;
      while (index < source.length && /[0-9a-fA-F_.xXbBoOlLfFdD+-]/.test(source[index] ?? "")) {
        const current = source[index] ?? "";
        // A sign only continues a number directly after an exponent marker.
        if ((current === "+" || current === "-") && !/[eEpP]/.test(source[index - 1] ?? "")) {
          break;
        }
        if (current === "." && !/[0-9a-fA-F_]/.test(source[index + 1] ?? "")) {
          // A trailing dot ends the literal unless a digit follows (`1.` is legal, `1.foo` is not).
          if (!/[0-9]/.test(source[index + 1] ?? "")) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      push("number", start, index);
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      while (index < source.length && isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      const value = source.slice(start, index);
      push(JAVA_KEYWORDS.has(value) ? "keyword" : "identifier", start, index);
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) {
      throw new Error(`unexpected character ${JSON.stringify(character)} on line ${line}`);
    }
    push("operator", index, index + operator.length);
    index += operator.length;
  }

  return { tokens, comments };
}
