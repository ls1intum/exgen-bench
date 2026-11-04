import { describe, expect, test } from "bun:test";

import type { CatalogTest } from "../tools/kit/test-catalog.ts";
import type { BuildOutcome } from "../tools/tier1-deterministic/java-oracle/backend.ts";
import {
  findMainProbe,
  hardCodedMain,
  javaStringLiteral,
  runMainInitScript,
} from "../tools/tier1-deterministic/java-oracle/bypass.ts";
import { assignLanes, bypassScore } from "../tools/tier1-deterministic/java-oracle/evaluate.ts";

const file = (path: string, content: string) => ({ path, content, bytes: content.length });

const STUB = `package p;

public class Client {
    public static void main(String[] args) {
        // TODO
    }
}
`;

const SOLUTION = `package p;

public class Client {
    private static final String NAME = "Ada";

    static String greet(String name) { return "Hi " + name; }

    public static void main(String[] args) throws Exception {
        System.out.println(greet(NAME));
        if (args.length > 0) { System.out.println("}"); }
    }
}
`;

const TESTS = [
  file("test/p/ClientTest.java", "class ClientTest { void t() { Client.main(new String[0]); } }"),
];

describe("the bypass probe", () => {
  test("applies to a changed class whose main the tests call", () => {
    expect(
      findMainProbe(
        [file("src/p/Client.java", STUB)],
        [file("src/p/Client.java", SOLUTION)],
        TESTS,
      ),
    ).toEqual({ className: "p.Client", path: "src/p/Client.java" });
  });

  test("does not apply to a given main, an untested main or a program that reads input", () => {
    const given = [file("src/p/Client.java", SOLUTION)];
    expect(findMainProbe(given, given, TESTS)).toMatchObject({
      unavailable: expect.stringContaining("declares public static void main"),
    });
    expect(
      findMainProbe([file("src/p/Client.java", STUB)], [file("src/p/Client.java", SOLUTION)], []),
    ).toMatchObject({ unavailable: expect.stringContaining("no test calls") });
    expect(
      findMainProbe(
        [file("src/p/Client.java", STUB)],
        [
          file(
            "src/p/Client.java",
            SOLUTION.replace("greet(NAME)", "new java.util.Scanner(System.in).next()"),
          ),
        ],
        TESTS,
      ),
    ).toMatchObject({ unavailable: expect.stringContaining("standard input") });
  });

  test("replaces only main's body and keeps every other member", () => {
    const replaced = hardCodedMain("src/p/Client.java", SOLUTION, 'Hi "Ada"\n') ?? "";
    expect(replaced).toContain('System.out.print("Hi \\"Ada\\"\\n");');
    expect(replaced).toContain("static String greet(String name)");
    expect(replaced).toContain("public static void main(String[] args) throws Exception {");
    expect(replaced).not.toContain("System.out.println(greet(NAME));");
    expect(replaced.trimEnd().endsWith("}\n}")).toBe(true);
  });

  test("escapes any transcript into one Java string literal", () => {
    expect(javaStringLiteral('a\\b"c\r\n\tä€😀\u0001')).toBe(
      '"a\\\\b\\"c\\r\\n\\tä€😀\\u0001"'
        .replace("ä", "\\u00e4")
        .replace("€", "\\u20ac")
        .replace("😀", "\\ud83d\\ude00"),
    );
  });

  test("runs main with empty input and a time limit, and refuses a forged class name", () => {
    const script = runMainInitScript("p.Client", 20);
    expect(script).toContain("mainClass = 'p.Client'");
    expect(script).toContain("new ByteArrayInputStream(new byte[0])");
    expect(script).toContain("Duration.ofSeconds(20)");
    expect(() => runMainInitScript("p.Client'; x('", 20)).toThrow("not a Java class name");
  });
});

const catalog: CatalogTest[] = [
  {
    id: 1,
    name: "printsLine",
    type: "BEHAVIORAL",
    weight: 1,
    bonusPoints: 0,
    visibility: "ALWAYS",
    active: true,
  },
  {
    id: 2,
    name: "printsCount",
    type: "BEHAVIORAL",
    weight: 1,
    bonusPoints: 0,
    visibility: "ALWAYS",
    active: true,
  },
  {
    id: 3,
    name: "givenCodeWorks",
    type: "BEHAVIORAL",
    weight: 0,
    bonusPoints: 0,
    visibility: "ALWAYS",
    active: true,
  },
];

function outcome(bypass?: BuildOutcome["bypass"]): BuildOutcome {
  const all = catalog.map((test) => ({ name: test.name, passed: true }));
  return {
    template: {
      compiled: true,
      tests_executed: true,
      test_cases: all.map((testCase) => ({
        ...testCase,
        passed: testCase.name === "givenCodeWorks",
      })),
      coverage: null,
      diagnostics: [],
    },
    solution: {
      compiled: true,
      tests_executed: true,
      test_cases: all,
      coverage: null,
      diagnostics: [],
    },
    attestation: {
      backend_id: "gradle",
      artemis_revision: null,
      build_agent_image: null,
      build_script_revision: null,
      toolchain: null,
      build_phase_scripts: [],
      build_branch: null,
      unattested: [],
    },
    ...(bypass === undefined ? {} : { bypass }),
  };
}

describe("the bypass score", () => {
  const measured = (passed: string[]) =>
    outcome({
      status: "measured",
      main_class: "p.Client",
      transcript_characters: 10,
      test_cases: catalog.map((test) => ({ name: test.name, passed: passed.includes(test.name) })),
    });

  test("is true, which is bad, when the transcript passes every gradable test", () => {
    const value = measured(["printsLine", "printsCount"]);
    expect(bypassScore(value, assignLanes(value, catalog))).toMatchObject({
      status: "ok",
      value: true,
      numerator: 2,
      denominator: 2,
    });
  });

  test("is false and names the detecting tests when one gradable test fails", () => {
    const value = measured(["printsLine", "givenCodeWorks"]);
    const result = bypassScore(value, assignLanes(value, catalog));
    expect(result).toMatchObject({ value: false, numerator: 1, denominator: 2 });
    expect(result.evidence).toContain("detected_by:printsCount");
  });

  test("is not applicable when a gradable test never ran on the solution", () => {
    const value = measured(["printsLine"]);
    value.solution.test_cases = value.solution.test_cases.filter(
      (testCase) => testCase.name !== "printsCount",
    );
    const result = bypassScore(value, assignLanes(value, catalog));
    expect(result).toMatchObject({ status: "not_applicable" });
    expect(result.message).toContain("printsCount");
  });

  test("is an infrastructure failure when the bypass build left out a gradable test", () => {
    const value = outcome({
      status: "measured",
      main_class: "p.Client",
      transcript_characters: 10,
      test_cases: [{ name: "printsLine", passed: true }],
    });
    const result = bypassScore(value, assignLanes(value, catalog));
    expect(result.status).toBe("infra_failure");
    expect(result.value).toBeUndefined();
    expect(result.message).toContain("printsCount");
  });

  test("is not applicable without lanes, without a probe, or on a backend that runs none", () => {
    const value = measured(["printsLine", "printsCount"]);
    expect(bypassScore(value, assignLanes(value, null)).status).toBe("not_applicable");
    const skipped = outcome({
      status: "not_applicable",
      reason: "no test calls the main method of a class the solution changes",
      main_class: null,
      transcript_characters: 0,
      test_cases: [],
    });
    expect(bypassScore(skipped, assignLanes(skipped, catalog))).toMatchObject({
      status: "not_applicable",
      message: "no test calls the main method of a class the solution changes",
    });
    expect(bypassScore(outcome(), assignLanes(outcome(), catalog)).message).toContain(
      "does not run the bypass probe",
    );
  });
});
