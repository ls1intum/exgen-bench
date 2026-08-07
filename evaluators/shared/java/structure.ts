import { tokenizeJava, type Token } from "./lexer.ts";

/**
 * Brace-level structure recovery over the token stream.
 *
 * This is not a parser. It recovers type declarations, method declarations with their body token
 * ranges, and the nesting depth of every token, from balanced delimiters and a small set of
 * declaration patterns. It resolves no types, overloads or imports, so what it reports is
 * approximate in *both* directions and every metric built on it inherits that:
 *
 *   - "recursion" is a call to the enclosing method's own name, so a same-named overload counts;
 *   - a construct is "present" when its syntax appears, not when it executes;
 *   - a method inside an anonymous class or a lambda is attributed to the enclosing declaration;
 *   - an explicit type argument on a call at member level (`Collections.<String>emptyList()`) is
 *     read as a method declaration, because the token before the name is `>` either way.
 */

export interface MethodDeclaration {
  name: string;
  /** Index of the token that opens the body, or null for an abstract or interface method. */
  bodyStart: number | null;
  bodyEnd: number | null;
  parameterCount: number;
  line: number;
  typeName: string | null;
  isConstructor: boolean;
}

export interface TypeDeclaration {
  name: string;
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  line: number;
}

export interface JavaUnit {
  path: string;
  tokens: Token[];
  comments: Token[];
  /** Nesting depth of each token, counted in braces; parallel to `tokens`. */
  depths: number[];
  packageName: string | null;
  imports: string[];
  types: TypeDeclaration[];
  methods: MethodDeclaration[];
}

const TYPE_KEYWORDS = new Map<string, TypeDeclaration["kind"]>([
  ["class", "class"],
  ["interface", "interface"],
  ["enum", "enum"],
  ["record", "record"],
]);

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "strictfp",
  "transient",
  "volatile",
  "default",
  "sealed",
  "non-sealed",
]);

function matchingDelimiter(tokens: Token[], open: number): number {
  const opener = tokens[open]?.value;
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : opener === "[" ? "]" : null;
  if (closer === null) {
    return -1;
  }
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === opener) {
      depth += 1;
    } else if (value === closer) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function countParameters(tokens: Token[], open: number, close: number): number {
  if (close <= open + 1) {
    return 0;
  }
  let depth = 0;
  let count = 1;
  for (let index = open + 1; index < close; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(" || value === "[" || value === "{" || value === "<") {
      depth += 1;
    } else if (value === ")" || value === "]" || value === "}" || value === ">") {
      depth -= 1;
    } else if (value === "," && depth === 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * Whether the `(` after the identifier at `nameIndex` opens a declaration rather than a call: a call
 * is preceded by something that can end an expression, a declaration by a type or a modifier.
 */
function looksLikeMethodDeclaration(tokens: Token[], nameIndex: number, close: number): boolean {
  const previous = tokens[nameIndex - 1];
  const following = tokens[close + 1];
  if (following === undefined) {
    return false;
  }
  if (following.value !== "{" && following.value !== ";" && following.value !== "throws") {
    return false;
  }
  if (previous === undefined) {
    return false;
  }
  // A call is preceded by `.`, `new`, `::` or an operator; a declaration by a type or a modifier.
  if ([".", "::", "new", ",", "(", "=", "return", "+", "-", "*", "/"].includes(previous.value)) {
    return false;
  }
  if (previous.kind === "identifier" || previous.value === ">" || previous.value === "]") {
    return true;
  }
  if (previous.kind === "keyword" && !MODIFIERS.has(previous.value)) {
    // A primitive or `void` return type is a keyword; `if (`, `while (` etc. are not declarations.
    return ["void", "int", "long", "short", "byte", "char", "boolean", "float", "double"].includes(
      previous.value,
    );
  }
  return previous.kind === "keyword" && MODIFIERS.has(previous.value);
}

export function analyseJavaUnit(path: string, source: string): JavaUnit {
  const { tokens, comments } = tokenizeJava(source);
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === "}") {
      depth = Math.max(0, depth - 1);
    }
    depths.push(depth);
    if (token.value === "{") {
      depth += 1;
    }
  }

  let packageName: string | null = null;
  const imports: string[] = [];
  const types: TypeDeclaration[] = [];
  const methods: MethodDeclaration[] = [];
  // Type bodies, innermost last, so a method can be attributed to its enclosing declaration.
  const openTypes: Array<{ name: string; end: number }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    while (openTypes.length > 0 && index > (openTypes.at(-1)?.end ?? Number.POSITIVE_INFINITY)) {
      openTypes.pop();
    }

    if (token.value === "package" && token.kind === "keyword") {
      packageName = readQualifiedName(tokens, index + 1);
      continue;
    }
    if (token.value === "import" && token.kind === "keyword") {
      const name = readQualifiedName(tokens, index + 1);
      if (name !== null) {
        imports.push(name);
      }
      continue;
    }

    const typeKind =
      TYPE_KEYWORDS.get(token.value) ??
      (token.value === "@" && tokens[index + 1]?.value === "interface" ? "annotation" : undefined);
    // `record` is a contextual keyword, so the lexer reports it as an identifier.
    const isTypeDeclaration =
      typeKind !== undefined &&
      (token.kind === "keyword" || token.value === "record" || token.value === "@");
    if (isTypeDeclaration) {
      const nameIndex = token.value === "@" ? index + 2 : index + 1;
      const name = tokens[nameIndex];
      if (name?.kind === "identifier") {
        types.push({ name: name.value, kind: typeKind, line: token.line });
        const bodyStart = findNextBrace(tokens, nameIndex);
        if (bodyStart >= 0) {
          openTypes.push({ name: name.value, end: matchingDelimiter(tokens, bodyStart) });
        }
      }
      // Resume past the `interface` of `@interface`, or it declares the same type a second time.
      index = nameIndex - 1;
      continue;
    }

    if (token.value !== "(") {
      continue;
    }
    const close = matchingDelimiter(tokens, index);
    if (close < 0) {
      continue;
    }
    const name = tokens[index - 1];
    if (name === undefined || name.kind !== "identifier") {
      continue;
    }
    if (!looksLikeMethodDeclaration(tokens, index - 1, close)) {
      continue;
    }
    let bodyStart: number | null = null;
    let bodyEnd: number | null = null;
    const afterSignature = findNextBrace(tokens, close, ";");
    if (afterSignature >= 0) {
      bodyStart = afterSignature;
      bodyEnd = matchingDelimiter(tokens, afterSignature);
      if (bodyEnd < 0) {
        bodyStart = null;
        bodyEnd = null;
      }
    }
    const enclosing = openTypes.at(-1)?.name ?? null;
    methods.push({
      name: name.value,
      bodyStart,
      bodyEnd,
      parameterCount: countParameters(tokens, index, close),
      line: name.line,
      typeName: enclosing,
      isConstructor: enclosing !== null && enclosing === name.value,
    });
    if (bodyEnd !== null) {
      index = bodyEnd;
    }
  }

  return { path, tokens, comments, depths, packageName, imports, types, methods };
}

function findNextBrace(tokens: Token[], from: number, stopAt = ""): number {
  for (let index = from; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "{") {
      return index;
    }
    if (value === ";" || (stopAt !== "" && value === stopAt)) {
      return -1;
    }
  }
  return -1;
}

function readQualifiedName(tokens: Token[], from: number): string | null {
  const parts: string[] = [];
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.value === ";") {
      break;
    }
    if (token.kind === "identifier" || token.value === "*" || token.value === "static") {
      parts.push(token.value);
    } else if (token.value !== ".") {
      break;
    }
  }
  return parts.length === 0 ? null : parts.join(".");
}

/** Every method body token, or an empty list for an abstract declaration. */
export function methodBodyTokens(unit: JavaUnit, method: MethodDeclaration): Token[] {
  if (method.bodyStart === null || method.bodyEnd === null) {
    return [];
  }
  return unit.tokens.slice(method.bodyStart + 1, method.bodyEnd);
}

/**
 * Whether a method calls its own name inside its body, unqualified or through `this`. A call through
 * any other receiver is a call on another object, however it is named; a same-named overload on the
 * enclosing type still counts, as the file header says.
 */
export function callsItself(unit: JavaUnit, method: MethodDeclaration): boolean {
  const body = methodBodyTokens(unit, method);
  return body.some((token, index) => {
    if (token.kind !== "identifier" || token.value !== method.name) {
      return false;
    }
    if (body[index + 1]?.value !== "(") {
      return false;
    }
    return body[index - 1]?.value !== "." || body[index - 2]?.value === "this";
  });
}
