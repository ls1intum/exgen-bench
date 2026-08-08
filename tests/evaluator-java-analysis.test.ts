import { describe, expect, test } from "bun:test";
import { cognitiveComplexity, cyclomaticComplexity } from "../evaluators/shared/java/complexity.ts";
import { tokenizeJava } from "../evaluators/shared/java/lexer.ts";
import {
  analyseJavaUnit,
  callsItself,
  methodBodyTokens,
  type MethodDeclaration,
} from "../evaluators/shared/java/structure.ts";
import { codeBleu } from "../evaluators/java-reference/codebleu.ts";
import {
  normalisedTreeEditDistance,
  structureTree,
  treeEditDistance,
  treeSize,
} from "../evaluators/java-reference/tree.ts";
import { detectConstructs } from "../evaluators/java-static/spec.ts";

function unit(source: string) {
  return analyseJavaUnit("Fixture.java", source);
}

function body(source: string) {
  return tokenizeJava(source).tokens;
}

function requireMethod(analysed: ReturnType<typeof unit>, name: string): MethodDeclaration {
  const method = analysed.methods.find((candidate) => candidate.name === name);
  if (method === undefined) {
    throw new Error(`the fixture declares no method named ${name}`);
  }
  return method;
}

describe("Java lexer", () => {
  test("separates comments from tokens", () => {
    const { tokens, comments } = tokenizeJava(`
      // a line comment
      int x = 1; /* a block
                    comment */ int y = 2;
      /** javadoc */
    `);
    expect(comments).toHaveLength(3);
    expect(comments[1]?.line).toBe(3);
    expect(tokens.map((token) => token.value)).toEqual([
      "int",
      "x",
      "=",
      "1",
      ";",
      "int",
      "y",
      "=",
      "2",
      ";",
    ]);
  });

  test("reads string, character and text-block literals as single tokens", () => {
    const { tokens } = tokenizeJava(
      'String a = "one \\" two"; char b = \'\\\'\'; String c = """\nmulti "quoted" line\n""";',
    );
    const literals = tokens.filter(
      (token) => token.kind === "string" || token.kind === "character",
    );
    expect(literals).toHaveLength(3);
    expect(literals[0]?.value).toBe('"one \\" two"');
    expect(literals[2]?.value).toContain('multi "quoted" line');
  });

  test("does not mistake literal content for code", () => {
    const { tokens } = tokenizeJava('String s = "for (int i = 0; i < 10; i++) {}";');
    expect(tokens.some((token) => token.value === "for")).toBe(false);
  });

  test("reads numeric literals with separators, radixes and exponents", () => {
    const { tokens } = tokenizeJava(
      "long a = 1_000_000L; int b = 0xFF; double c = 1.5e-3; int d = 0b1010;",
    );
    expect(tokens.filter((token) => token.kind === "number").map((token) => token.value)).toEqual([
      "1_000_000L",
      "0xFF",
      "1.5e-3",
      "0b1010",
    ]);
  });

  test("reads multi-character operators greedily, except a run of closing angle brackets", () => {
    const { tokens } = tokenizeJava("a >>>= b; c -> d; e::f; g <= h;");
    const values = tokens.map((token) => token.value);
    expect(values).toContain("->");
    expect(values).toContain("::");
    expect(values).toContain("<=");
    // No `>` is merged with the `>` after it, which is what lets a nested type argument list be
    // balanced by counting.
    expect(values).not.toContain(">>>=");
    expect(values.slice(1, 4)).toEqual([">", ">", ">="]);
  });

  test("balances a nested type argument list, so the method it returns is recovered", () => {
    const source =
      "class A { java.util.Map<String, java.util.List<Integer>> classify(int a) { if (a > 0) { return null; } return null; } }";
    const unit = analyseJavaUnit("A.java", source);
    expect(unit.methods.map((method) => method.name)).toEqual(["classify"]);
    expect(detectConstructs([unit])).toContain("generics");
  });

  test("rejects an unterminated literal or comment", () => {
    expect(() => tokenizeJava('String s = "open;')).toThrow(/unterminated/);
    expect(() => tokenizeJava("/* never closed")).toThrow(/unterminated block comment/);
  });
});

describe("Java structure recovery", () => {
  const source = `
    package de.tum.in.ase;

    import java.util.List;
    import java.util.stream.Collectors;

    public class Calculator {

        private int value;

        public Calculator(int value) {
            this.value = value;
        }

        public int factorial(int n) {
            if (n <= 1) {
                return 1;
            }
            return n * factorial(n - 1);
        }

        public int doubled() {
            return value * 2;
        }
    }
  `;

  test("recovers the package, imports and type declaration", () => {
    const analysed = unit(source);
    expect(analysed.packageName).toBe("de.tum.in.ase");
    expect(analysed.imports).toEqual(["java.util.List", "java.util.stream.Collectors"]);
    expect(analysed.types).toEqual([{ name: "Calculator", kind: "class", line: 7 }]);
  });

  test("recovers methods with their bodies, parameters and enclosing type", () => {
    const analysed = unit(source);
    expect(analysed.methods.map((method) => method.name)).toEqual([
      "Calculator",
      "factorial",
      "doubled",
    ]);
    const factorial = requireMethod(analysed, "factorial");
    expect(factorial.parameterCount).toBe(1);
    expect(factorial.typeName).toBe("Calculator");
    expect(factorial.isConstructor).toBe(false);
    expect(analysed.methods[0]?.isConstructor).toBe(true);
    expect(methodBodyTokens(analysed, factorial).length).toBeGreaterThan(10);
  });

  test("does not mistake a call or a control-flow head for a declaration", () => {
    const analysed = unit(`
      class A {
          void run(int n) {
              if (n > 0) {
                  helper(n);
                  while (n > 0) { n--; }
              }
          }
          void helper(int n) {}
      }
    `);
    expect(analysed.methods.map((method) => method.name)).toEqual(["run", "helper"]);
  });

  test("recognises an abstract or interface method as having no body", () => {
    const analysed = unit("interface Shape { double area(); }");
    expect(analysed.types[0]?.kind).toBe("interface");
    const area = requireMethod(analysed, "area");
    expect(area.bodyStart).toBeNull();
    expect(methodBodyTokens(analysed, area)).toEqual([]);
  });

  test("detects self-recursion by name", () => {
    const analysed = unit(source);
    expect(callsItself(analysed, requireMethod(analysed, "factorial"))).toBe(true);
    expect(callsItself(analysed, requireMethod(analysed, "doubled"))).toBe(false);
  });
});

describe("complexity", () => {
  test("cyclomatic complexity counts decision points and not else", () => {
    expect(cyclomaticComplexity(body("{ return 1; }"))).toBe(1);
    expect(cyclomaticComplexity(body("{ if (a) { return 1; } else { return 2; } }"))).toBe(2);
    expect(cyclomaticComplexity(body("{ if (a && b || c) { return 1; } }"))).toBe(4);
    expect(
      cyclomaticComplexity(body("{ for (int i = 0; i < n; i++) { if (i % 2 == 0) { s += i; } } }")),
    ).toBe(3);
    expect(cyclomaticComplexity(body("{ try { f(); } catch (Exception e) { g(); } }"))).toBe(2);
  });

  test("cognitive complexity charges nesting but not a plain block", () => {
    expect(cognitiveComplexity(body("{ { { return 1; } } }"))).toBe(0);
    expect(cognitiveComplexity(body("{ if (a) { return 1; } }"))).toBe(1);
    // if (+1) then a nested if (+2) = 3.
    expect(cognitiveComplexity(body("{ if (a) { if (b) { return 1; } } }"))).toBe(3);
    // for (+1) then a nested if (+2) = 3, the same shape the fixture solution has.
    expect(
      cognitiveComplexity(body("{ for (int v : values) { if (v % 2 == 0) { t += v; } } }")),
    ).toBe(3);
  });

  test("cognitive complexity charges an else once and a boolean sequence once", () => {
    expect(cognitiveComplexity(body("{ if (a) { f(); } else { g(); } }"))).toBe(2);
    expect(cognitiveComplexity(body("{ if (a && b && c) { f(); } }"))).toBe(2);
    expect(cognitiveComplexity(body("{ if (a && b || c) { f(); } }"))).toBe(3);
  });

  test("cognitive complexity exceeds cyclomatic complexity on deeply nested code", () => {
    const nested = body(`{
      for (int i = 0; i < n; i++) {
        if (a) {
          while (b) {
            if (c) { f(); }
          }
        }
      }
    }`);
    expect(cyclomaticComplexity(nested)).toBe(5);
    expect(cognitiveComplexity(nested)).toBe(1 + 2 + 3 + 4);
  });
});

describe("construct detection", () => {
  test("detects the constructs a spec can require", () => {
    const constructs = detectConstructs([
      unit(`
        import java.util.stream.Collectors;
        class A extends B {
          int[] data;
          java.util.List<String> names;
          int f(int n) { return n <= 1 ? 1 : f(n - 1); }
          void g() { try { for (int i = 0; i < 3; i++) { switch (i) { default: break; } } } catch (Exception e) {} }
          void h() { names.stream().collect(Collectors.toList()); }
        }
      `),
    ]);
    expect([...constructs].sort()).toEqual([
      "array",
      "conditional",
      "generics",
      "inheritance",
      "loop",
      "recursion",
      "stream_api",
      "switch",
      "ternary",
      "try_catch",
    ]);
  });

  test("does not report generics for a comparison", () => {
    expect(
      detectConstructs([unit("class A { boolean f(int a, int b) { return a < b; } }")]),
    ).not.toContain("generics");
  });

  test("does not report a construct that appears only in a string literal", () => {
    const constructs = detectConstructs([
      unit('class A { String hint() { return "use a for loop and a stream().collect()"; } }'),
    ]);
    expect(constructs.has("loop")).toBe(false);
    expect(constructs.has("stream_api")).toBe(false);
  });

  test("does not read a wildcard or a type bound as a ternary, conditional or supertype", () => {
    // `Class<?>` is a wildcard, not a `? :`.
    const wildcard = detectConstructs([unit("class A { void m(Class<?> c) {} }")]);
    expect(wildcard.has("ternary")).toBe(false);
    expect(wildcard.has("conditional")).toBe(false);
    expect(wildcard.has("generics")).toBe(true);
    // `<T extends Number>` is a bound, not inheritance -- as a class header and as a generic method.
    for (const source of [
      "class A { <T extends Number> T id(T v) { return v; } }",
      "class A { public <T extends Number> T id(T v) { return v; } }",
      "class A { void m(java.util.List<? extends Number> xs) {} }",
    ]) {
      const bound = detectConstructs([unit(source)]);
      expect(bound.has("inheritance")).toBe(false);
      expect(bound.has("generics")).toBe(true);
    }
  });

  test("does not read a switch rule arrow as a lambda", () => {
    const constructs = detectConstructs([
      unit("class A { int m(int d) { return switch (d) { case 1 -> 10; default -> 0; }; } }"),
    ]);
    expect(constructs.has("lambda")).toBe(false);
    expect(constructs.has("switch")).toBe(true);
    expect(constructs.has("conditional")).toBe(true);
  });

  test("still detects a real ternary, lambda, method reference and both inheritance forms", () => {
    expect(
      detectConstructs([unit("class A { int m(int n) { return n > 0 ? 1 : -1; } }")]),
    ).toContain("ternary");
    expect(
      detectConstructs([
        unit(
          "class A { void m(java.util.List<Integer> xs) { xs.forEach(v -> System.out.println(v)); } }",
        ),
      ]),
    ).toContain("lambda");
    expect(
      detectConstructs([
        unit("class A { void m(java.util.List<Integer> xs) { xs.forEach(System.out::println); } }"),
      ]),
    ).toContain("lambda");
    expect(detectConstructs([unit("class A extends Base {}")])).toContain("inheritance");
    expect(
      detectConstructs([unit("class A implements Runnable { public void run() {} }")]),
    ).toContain("inheritance");
  });

  test("reports a stream only on a real stream signal, not any fluent call", () => {
    const optional = detectConstructs([
      unit(
        "import java.util.Optional; class A { Optional<Integer> m(Optional<Integer> o) { return o.filter(v -> v > 0); } }",
      ),
    ]);
    expect(optional.has("stream_api")).toBe(false);
    const stream = detectConstructs([
      unit("class A { int m(int[] a) { return java.util.Arrays.stream(a).sum(); } }"),
    ]);
    expect(stream.has("stream_api")).toBe(true);
  });
});

describe("tree edit distance", () => {
  const solution = `
    class A {
      int sum(int[] values) {
        int total = 0;
        for (int value : values) {
          if (value % 2 == 0) { total += value; }
        }
        return total;
      }
    }
  `;

  test("is zero for identical structure and symmetric", () => {
    const left = structureTree(tokenizeJava(solution).tokens);
    const right = structureTree(tokenizeJava(solution).tokens);
    expect(treeEditDistance(left, right)).toBe(0);
    expect(normalisedTreeEditDistance(left, right)).toBe(0);
    expect(treeEditDistance(right, left)).toBe(0);
  });

  test("is blind to renaming, because it compares shape", () => {
    const renamed = solution.replaceAll("total", "accumulator").replaceAll("value", "element");
    expect(
      normalisedTreeEditDistance(
        structureTree(tokenizeJava(solution).tokens),
        structureTree(tokenizeJava(renamed).tokens),
      ),
    ).toBe(0);
  });

  test("grows with structural change and stays within [0, 1]", () => {
    const restructured = solution.replace(
      "for (int value : values) {\n          if (value % 2 == 0) { total += value; }\n        }",
      "int index = 0;\n        while (index < values.length) { total += values[index]; index++; }",
    );
    const unrelated = "class Z { void noop() {} }";
    const base = structureTree(tokenizeJava(solution).tokens);
    const near = normalisedTreeEditDistance(base, structureTree(tokenizeJava(restructured).tokens));
    const far = normalisedTreeEditDistance(base, structureTree(tokenizeJava(unrelated).tokens));
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(1);
  });

  test("counts every node of the structure tree", () => {
    // The unit root, the `class` keyword, the normalised type name, and the brace group.
    const tree = structureTree(tokenizeJava("class A { }").tokens);
    expect(treeSize(tree)).toBe(4);
    expect(tree.children.map((child) => child.label)).toEqual(["class", "ID", "group{"]);
  });
});

describe("CodeBLEU", () => {
  const reference = `
    class EvenSum {
      int sumEven(int[] values) {
        int total = 0;
        for (int value : values) {
          if (value % 2 == 0) { total += value; }
        }
        return total;
      }
    }
  `;

  test("is one for an identical candidate", () => {
    const result = codeBleu(reference, reference);
    expect(result.score).toBeCloseTo(1, 12);
    expect(result.components.syntax_match).toBeCloseTo(1, 12);
    expect(result.components.variable_usage_match).toBeCloseTo(1, 12);
  });

  test("orders renamed, restructured and unrelated candidates", () => {
    const renamed = reference.replaceAll("total", "accumulator").replaceAll("value", "element");
    const reordered = `
      class EvenSum {
        int helper(int v) { return v; }
        int sumEven(int[] values) {
          int total = 0;
          for (int value : values) {
            if (value % 2 == 0) { total += value; }
          }
          return total;
        }
      }
    `;
    const unrelated = 'class Greeter { String greet(String name) { return "hi " + name; } }';
    const identical = codeBleu(reference, reference).score;
    const renamedScore = codeBleu(renamed, reference).score;
    const reorderedScore = codeBleu(reordered, reference).score;
    const unrelatedScore = codeBleu(unrelated, reference).score;
    expect(identical).toBeGreaterThan(renamedScore);
    expect(renamedScore).toBeGreaterThan(unrelatedScore);
    expect(reorderedScore).toBeGreaterThan(unrelatedScore);
    expect(unrelatedScore).toBeGreaterThanOrEqual(0);
  });

  test("renaming moves the surface components but not the syntax component", () => {
    const renamed = reference.replaceAll("total", "accumulator").replaceAll("value", "element");
    const result = codeBleu(renamed, reference);
    expect(result.components.syntax_match).toBeCloseTo(1, 12);
    expect(result.components.ngram_match).toBeLessThan(1);
  });

  test("is bounded and reports its components and weights", () => {
    const result = codeBleu("class A {}", reference);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(Object.values(result.weights).reduce((total, weight) => total + weight, 0)).toBeCloseTo(
      1,
      12,
    );
    expect(result.reference_tokens).toBeGreaterThan(result.candidate_tokens);
  });
});
