import type { Token } from "./lexer.ts";
import { methodBodyTokens, type JavaUnit, type MethodDeclaration } from "./structure.ts";

export interface MethodComplexity {
  type_name: string | null;
  method_name: string;
  line: number;
  cyclomatic: number;
  cognitive: number;
  body_tokens: number;
}

const DECISION_KEYWORDS = new Set(["if", "for", "while", "case", "catch"]);
const NESTING_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "do"]);

/**
 * McCabe cyclomatic complexity: one plus every decision point.
 *
 * `else` is not a decision point, since it adds no independent path. `default:` is not one either,
 * following the common convention that a default arm is the fall-through rather than a new branch.
 */
export function cyclomaticComplexity(body: Token[]): number {
  let complexity = 1;
  for (const token of body) {
    if (token.kind === "keyword" && (DECISION_KEYWORDS.has(token.value) || token.value === "do")) {
      complexity += 1;
    } else if (
      token.kind === "operator" &&
      (token.value === "&&" || token.value === "||" || token.value === "?")
    ) {
      complexity += 1;
    }
  }
  return complexity;
}

/**
 * Cognitive complexity in the sense of Campbell (2018): control flow costs more the deeper it sits.
 *
 * Nesting level is tracked from the braces of nesting structures only, so a plain block or a class
 * body does not deepen it, and a lambda does deepen it whether or not it uses braces.
 */
export function cognitiveComplexity(body: Token[]): number {
  let complexity = 0;
  let nesting = 0;
  // Brace depth each open nesting structure was entered at. A structure whose body sits at depth
  // d + 1 closes back to d, so its level is released once the depth is no longer greater than d.
  const nestingBraces: number[] = [];
  let braceDepth = 0;
  let previousBooleanOperator: string | null = null;

  for (let index = 0; index < body.length; index += 1) {
    const token = body[index];
    if (token === undefined) {
      continue;
    }
    if (token.value === "{") {
      braceDepth += 1;
      previousBooleanOperator = null;
      continue;
    }
    if (token.value === "}") {
      braceDepth -= 1;
      previousBooleanOperator = null;
      while (nestingBraces.length > 0 && (nestingBraces.at(-1) ?? 0) >= braceDepth) {
        nestingBraces.pop();
        nesting = Math.max(0, nesting - 1);
      }
      continue;
    }
    if (token.kind === "operator") {
      if (token.value === "&&" || token.value === "||") {
        // A run of like operators costs one, so an operand must not reset the run, but a bracket or
        // a statement boundary must: a parenthesised subexpression is a sequence of its own.
        if (previousBooleanOperator !== token.value) {
          complexity += 1;
        }
        previousBooleanOperator = token.value;
        continue;
      }
      if (token.value === "?" && body[index + 1]?.value !== ":") {
        complexity += 1 + nesting;
      }
      if (token.value === "->") {
        // A lambda body nests, whether or not it uses braces.
        nesting += 1;
        nestingBraces.push(braceDepth);
      }
      if (["(", ")", ";", ",", "?", ":"].includes(token.value)) {
        previousBooleanOperator = null;
      }
      continue;
    }
    if (token.kind !== "keyword") {
      continue;
    }
    previousBooleanOperator = null;
    if (token.value === "else") {
      complexity += 1;
      // `else if` must not be charged twice: skip the `if` that follows.
      if (body[index + 1]?.value === "if") {
        index += 1;
        nesting += 1;
        nestingBraces.push(braceDepth);
      }
      continue;
    }
    if (NESTING_KEYWORDS.has(token.value)) {
      complexity += 1 + nesting;
      nesting += 1;
      nestingBraces.push(braceDepth);
      continue;
    }
    if (
      (token.value === "break" || token.value === "continue") &&
      body[index + 1]?.kind === "identifier"
    ) {
      complexity += 1;
    }
  }
  return complexity;
}

export function unitComplexity(unit: JavaUnit): MethodComplexity[] {
  return unit.methods.map((method: MethodDeclaration): MethodComplexity => {
    const body = methodBodyTokens(unit, method);
    return {
      type_name: method.typeName,
      method_name: method.name,
      line: method.line,
      cyclomatic: cyclomaticComplexity(body),
      cognitive: cognitiveComplexity(body),
      body_tokens: body.length,
    };
  });
}
