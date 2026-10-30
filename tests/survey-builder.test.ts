import { describe, expect, test } from "bun:test";

import type { EvaluationScore } from "../src/evaluation/contracts.ts";
import type { BundleFile } from "../tools/kit/bundle.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
} from "../tools/tier1-deterministic/java-oracle/backend.ts";
import { templateDiff } from "../tools/tier3-expert-rating/builder/diff.ts";
import {
  automaticFindings,
  oracleGatesPassed,
} from "../tools/tier3-expert-rating/builder/findings.ts";
import {
  analyseMutants,
  applyMutant,
  changedLines,
  generateMutants,
  messageRank,
  type Mutant,
  type MutantResult,
  replacementValue,
  runMutants,
  stableMessage,
} from "../tools/tier3-expert-rating/builder/mutation.ts";
import { failureKind, testOverview } from "../tools/tier3-expert-rating/builder/tests.ts";

const PATH = "src/Shop.java";

const TEMPLATE = `package shop;

import java.util.ArrayList;
import java.util.List;

public class Shop {
    private int total;
    private final List<String> log = new ArrayList<>();

    /** Unchanged: the template already has it. */
    public int fixed(int a) {
        return a < 0 ? -a : a + 1;
    }

    public int price(int amount, boolean member) {
        throw new UnsupportedOperationException("Not implemented");
    }

    public List<String> names(List<String> items) {
        throw new UnsupportedOperationException("Not implemented");
    }
}
`;

const SOLUTION = `package shop;

import java.util.ArrayList;
import java.util.List;

public class Shop {
    private int total;
    private final List<String> log = new ArrayList<>();

    /** Unchanged: the template already has it. */
    public int fixed(int a) {
        return a < 0 ? -a : a + 1;
    }

    public int price(int amount, boolean member) {
        // a < b == c in a comment stays as it is
        if (amount <= 0 || !member) {
            log.add("rejected: amount < 0 == true");
            System.out.println("x < y");
            return -1;
        }
        int price = amount * 3 - 2;
        total += price;
        for (int i = 0; i < amount; i++) {
            price = price + 1;
        }
        if (member) {
            this.total = total;
        }
        boolean flag = true;
        return price;
    }

    public List<String> names(List<String> items) {
        List<String> result = new ArrayList<>();
        items.forEach(item -> {
            if (item.isEmpty()) {
                return;
            }
            result.add(item);
        });
        items.stream().map(item -> { return item + "!"; }).toList();
        return result;
    }
}
`;

const template = [{ path: PATH, content: TEMPLATE }];
const solution = [{ path: PATH, content: SOLUTION }];
const diff = templateDiff(template, solution);

function bundleFile(path: string, content: string): BundleFile {
  return { path, content, bytes: content.length };
}

describe("wrong variants of the sample solution", () => {
  const all = generateMutants(solution, diff, 1000);

  test("are the same every time and independent of the file order", () => {
    const other = { path: "src/Other.java", content: "class Other { int f() { return 1; } }\n" };
    const both = templateDiff(template, [...solution, other]);
    expect(generateMutants(solution, diff)).toEqual(generateMutants(solution, diff));
    expect(generateMutants([other, ...solution], both)).toEqual(
      generateMutants([...solution, other], both),
    );
    expect(all.map((mutant) => mutant.id)).toEqual(all.map((_, index) => `V${index + 1}`));
  });

  test("change only the lines the solution adds to the template", () => {
    const added = changedLines(diff).get(PATH);
    expect(added?.has(12)).toBe(false);
    expect(all.length).toBeGreaterThan(10);
    for (const mutant of all) {
      expect(added?.has(mutant.line)).toBe(true);
      expect(mutant.method).not.toBe("Shop.fixed");
    }
    expect(changedLines([{ path: "gone.java", change: "removed", hunks: [] }]).size).toBe(0);
  });

  test("never change a string literal or a comment", () => {
    const protectedRanges = [...SOLUTION.matchAll(/"[^"\n]*"|\/\/[^\n]*|\/\*\*[^\n]*\*\//g)].map(
      (match) => [match.index, match.index + match[0].length] as const,
    );
    for (const mutant of all) {
      for (const [start, end] of protectedRanges) {
        const overlaps = mutant.start < end && mutant.end > start;
        const encloses = mutant.start <= start && mutant.end >= end;
        // A removed statement may contain a string; it is never edited inside one.
        expect(overlaps && !encloses).toBe(false);
      }
    }
  });

  test("use the classic operators and leave type arguments, signs and printing alone", () => {
    const operators = new Set(all.map((mutant) => mutant.operator));
    expect([...operators].sort()).toEqual([
      "arithmetic",
      "boolean-literal",
      "increment",
      "logical-operator",
      "negate-condition",
      "negate-conditional",
      "relational-boundary",
      "remove-assignment",
      "remove-call",
      "remove-negation",
      "return-value",
    ]);
    const described = all.map((mutant) => mutant.description);
    expect(described).toContain(
      "Line 17 of Shop.java (price): `if (amount <= 0 || !member) {` became `if (amount < 0 || !member) {`",
    );
    expect(described).toContain("Line 31 of Shop.java (price): returns `0` instead of `price`");
    expect(described).toContain(
      'Line 18 of Shop.java (price): `log.add("rejected: amount < 0 == true");` left out',
    );
    expect(described).toContain("Line 23 of Shop.java (price): `total += price;` left out");
    expect(described).toContain(
      "Line 27 of Shop.java (price): `if (member) {` became `if (!(member)) {`",
    );
    expect(described).toContain(
      "Line 43 of Shop.java (names): returns `new java.util.ArrayList<>()` instead of `result`",
    );
    const at = (line: number) => all.filter((mutant) => mutant.line === line);
    // `List<String>` and `new ArrayList<>()` compare nothing, printing is no behaviour a test
    // checks, a sign is no subtraction, and a lambda's `return` is not the method's.
    expect(at(35)).toEqual([]);
    expect(at(19)).toEqual([]);
    expect(at(20).map((mutant) => [mutant.operator, mutant.replacement])).toEqual([
      ["return-value", "0"],
    ]);
    expect(at(38)).toEqual([]);
    expect(at(42).map((mutant) => mutant.operator)).toEqual(["remove-call"]);
    expect(at(22).map((mutant) => mutant.replacement)).toEqual(["/", "+"]);
    expect(at(24).map((mutant) => mutant.operator)).toEqual([
      "negate-conditional",
      "relational-boundary",
      "increment",
    ]);
  });

  test("show a long line around the change", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    const content = `class L {\n  boolean f(int a) {\n    return check(${names.map((name) => name.repeat(3)).join(", ")}) && a > 0;\n  }\n}\n`;
    const files = [{ path: "L.java", content }];
    const boundary = generateMutants(files, templateDiff([], files), 100).find(
      (candidate) => candidate.operator === "relational-boundary",
    );
    expect(boundary?.description).toMatch(
      /^Line 3 of L\.java \(f\): `….*&& a > 0;` became `….*&& a >= 0;`$/,
    );
  });

  test("leave out main, the assignment of a final field, and a variant that repeats another", () => {
    const content = `public class F {
    private final int a;
    private int b;
    public F(int x, final int b) {
        a = x;
        this.b = b;
        boolean y = !!this.flag();
    }
    public boolean flag() {
        return b > 0;
    }
    public static void main(String[] args) {
        int c = 1;
        c = c + 1;
        System.exit(c);
    }
}
`;
    const files = [{ path: "F.java", content }];
    const variants = generateMutants(files, templateDiff([], files), 100);
    expect(variants.some((variant) => variant.method === "F.main")).toBe(false);
    expect(
      variants
        .filter((variant) => variant.operator === "remove-assignment")
        .map((variant) => variant.description),
    ).toEqual(["Line 6 of F.java (F): `this.b = b;` left out"]);
    // Leaving out either `!` of `!!` yields the same code: one variant.
    expect(variants.filter((variant) => variant.operator === "remove-negation")).toHaveLength(1);
  });

  test("leave out the assignment of a field that only a final local elsewhere shares the name of", () => {
    const content = `public class G {
    private int count;
    private final int limit;
    public G() {
        limit = 3;
    }
    public void reset() {
        count = 0;
    }
    public int twice() {
        final int count = this.count * 2;
        return count;
    }
}
`;
    const files = [{ path: "G.java", content }];
    expect(
      generateMutants(files, templateDiff([], files), 100)
        .filter((variant) => variant.operator === "remove-assignment")
        .map((variant) => variant.description),
    ).toEqual(["Line 8 of G.java (reset): `count = 0;` left out"]);
  });

  test("spread over methods before a method gets a second variant", () => {
    const two = generateMutants(solution, diff, 2);
    expect(two.map((mutant) => mutant.method)).toEqual(["Shop.price", "Shop.names"]);
    expect(generateMutants(solution, diff).length).toBe(16);
  });

  test("replace a return value with one of the declared type", () => {
    expect(replacementValue("boolean", "a > b")).toBe("!(a > b)");
    expect(replacementValue("boolean", "true")).toBeNull();
    expect(replacementValue("int", "0")).toBe("1");
    expect(replacementValue("long", "count")).toBe("0L");
    expect(replacementValue("Long", "0L")).toBe("1L");
    expect(replacementValue("double", "x")).toBe("0.0");
    expect(replacementValue("float", "x")).toBe("0.0f");
    expect(replacementValue("char", "c")).toBe("(char) 0");
    expect(replacementValue("String", '""')).toBe("null");
    expect(replacementValue("Optional", "Optional.empty()")).toBeNull();
    expect(replacementValue("Optional", "found")).toBe("java.util.Optional.empty()");
    expect(replacementValue("Set", "s")).toBe("new java.util.HashSet<>()");
    expect(replacementValue("Map", "m")).toBe("new java.util.HashMap<>()");
    expect(replacementValue("void", "x")).toBeNull();
    expect(replacementValue("Shop", "null")).toBeNull();
    expect(replacementValue("Shop", "this")).toBe("null");
  });

  test("apply to the one file they change", () => {
    const mutant = all.find((candidate) => candidate.operator === "increment") as Mutant;
    const files = [bundleFile(PATH, SOLUTION), bundleFile("src/Other.java", "class Other {}")];
    const [changed, other] = applyMutant(files, mutant);
    expect(changed?.content).toContain("i--)");
    expect(changed?.bytes).toBe(new TextEncoder().encode(changed?.content ?? "").byteLength);
    expect(other).toBe(files[1]);
  });
});

describe("failure messages", () => {
  test("tell a test's own words from a bare assertion, an exception and nothing", () => {
    expect(
      failureKind("org.opentest4j.AssertionFailedError: price must be 3 ==> expected: <3>"),
    ).toBe("own");
    expect(failureKind("org.opentest4j.AssertionFailedError: expected: <3> but was: <0>")).toBe(
      "bare",
    );
    expect(failureKind("java.lang.AssertionError")).toBe("bare");
    expect(failureKind("expected: <1> but was: <0>")).toBe("bare");
    expect(failureKind("The area is pi.")).toBe("own");
    expect(failureKind('java.lang.NullPointerException: Cannot invoke "x"')).toBe("exception");
    expect(failureKind("org.opentest4j.AssertionFailedError: execution timed out after 1 s")).toBe(
      "exception",
    );
    // JUnit's own texts for assertThrows, assertArrayEquals and assertIterableEquals are bare.
    for (const bare of [
      "org.opentest4j.AssertionFailedError: Expected java.lang.IllegalArgumentException to be thrown, but nothing was thrown.",
      "org.opentest4j.AssertionFailedError: Unexpected exception type thrown, expected: <java.lang.IllegalArgumentException> but was: <java.lang.NullPointerException>",
      "array contents differ at index [2], expected: <3> but was: <4>",
      "org.opentest4j.AssertionFailedError: iterable contents differ at index [0], expected: <a> but was: <b>",
    ]) {
      expect(failureKind(bare)).toBe("bare");
    }
    // And so are those for assertDoesNotThrow and assertInstanceOf.
    for (const bare of [
      "org.opentest4j.AssertionFailedError: Unexpected exception thrown: java.lang.IllegalStateException: closed",
      "org.opentest4j.AssertionFailedError: Unexpected type, expected: <java.lang.String> but was: <java.lang.Integer>",
      "org.opentest4j.AssertionFailedError: Unexpected null value",
    ]) {
      expect(failureKind(bare)).toBe("bare");
    }
    expect(
      failureKind(
        "AssertionFailedError: price must throw ==> Expected java.lang.IllegalArgumentException to be thrown, but nothing was thrown.",
      ),
    ).toBe("own");
    expect(
      failureKind("AssertionFailedError: open must not throw ==> Unexpected exception thrown: x"),
    ).toBe("own");
    // A timeout is told by its class or by JUnit's and Ares's exact words, not by the word alone.
    expect(
      failureKind("java.util.concurrent.TimeoutException: testPrice() timed out after 1 second"),
    ).toBe("exception");
    expect(failureKind("testPrice() timed out after 100 milliseconds")).toBe("exception");
    expect(failureKind("execution exceeded timeout of 10 ms by 5 ms")).toBe("exception");
    expect(failureKind("The session must end after its timeout of 30 minutes.")).toBe("own");
    expect(
      failureKind(
        "org.opentest4j.AssertionFailedError: the timeout must be 5 ==> expected: <5> but was: <0>",
      ),
    ).toBe("own");
    expect(failureKind("  ")).toBe("none");
    expect(failureKind(undefined)).toBe("none");
    expect([
      messageRank("a ==> b"),
      messageRank("expected: <1>"),
      messageRank("java.lang.IllegalStateException"),
    ]).toEqual([3, 2, 1]);
    expect(messageRank(undefined)).toBe(0);
  });

  test("drop identity hash codes and lambda names, which differ between runs", () => {
    expect(stableMessage("expected: <Shop@1b6d3586> but was: <Shop$$Lambda/0x0000012>")).toBe(
      "expected: <Shop@…> but was: <Shop$$Lambda>",
    );
    expect(stableMessage("expected: <Shop@7f> but was: <Item@1234567890>")).toBe(
      "expected: <Shop@…> but was: <Item@1234567890>",
    );
  });
});

function mutant(id: string, method = "Shop.price"): Mutant {
  return {
    id,
    path: PATH,
    method,
    line: 1,
    operator: "negate-conditional",
    start: 0,
    end: 1,
    replacement: "x",
    description: `variant ${id}`,
  };
}

describe("choosing a message per test", () => {
  const result = (
    id: string,
    status: MutantResult["status"],
    failures: Array<[string, string]>,
    method?: string,
  ): MutantResult => ({
    mutant: mutant(id, method),
    status,
    failures: failures.map(([name, message]) => ({ name, passed: false, message })),
  });

  test("prefers the test's own words, then the variant that fails the fewest tests", () => {
    const analysis = analyseMutants([
      result("V1", "caught", [
        ["a", "java.lang.NullPointerException"],
        ["b", "AssertionFailedError: b broke ==> expected: <1> but was: <0>"],
        ["c", "AssertionFailedError: c broke"],
      ]),
      result("V2", "caught", [
        ["a", "AssertionFailedError: expected: <1> but was: <2>"],
        ["c", "AssertionFailedError: c broke differently"],
      ]),
      result("V3", "caught", [["c", "AssertionFailedError: c broke alone"]]),
      result("V4", "survived", []),
      result("V5", "discarded", []),
    ]);
    expect(analysis.ran).toBe(4);
    expect(analysis.caught).toBe(3);
    expect(analysis.survivors.map((survivor) => survivor.id)).toEqual(["V4"]);
    expect(
      Object.fromEntries(
        [...analysis.failures].map(([name, failure]) => [
          name,
          [failure.mutant.id, failure.message],
        ]),
      ),
    ).toEqual({
      a: ["V2", "AssertionFailedError: expected: <1> but was: <2>"],
      b: ["V1", "AssertionFailedError: b broke ==> expected: <1> but was: <0>"],
      c: ["V3", "AssertionFailedError: c broke alone"],
    });
  });

  test("among equally telling messages, prefers a variant of the method the test's name names", () => {
    const analysis = analyseMutants([
      result("V1", "caught", [["testComputeTotal", "java.lang.IllegalStateException"]]),
      result(
        "V2",
        "caught",
        [
          ["testComputeTotal", "java.lang.NullPointerException"],
          ["other", "java.lang.NullPointerException"],
        ],
        "Cart.computeTotal",
      ),
    ]);
    expect(analysis.failures.get("testComputeTotal")?.mutant.id).toBe("V2");
    // No variant changes a method `other` names: the most telling message wins.
    expect(analysis.failures.get("other")?.mutant.id).toBe("V2");
  });

  test("matches a method's name as whole words, and never over a more telling message", () => {
    const own = "AssertionFailedError: loansOf must list the books lent";
    const analysis = analyseMutants([
      result(
        "V1",
        "caught",
        [["testListsTitlesInLendingOrder", "java.lang.IllegalStateException"]],
        "Library.lend",
      ),
      result(
        "V2",
        "caught",
        [
          ["testListsTitlesInLendingOrder", "java.lang.NullPointerException"],
          ["x", "y"],
        ],
        "Library.order",
      ),
      result("V3", "caught", [["testCountActiveBooks", own]], "Library.lend"),
      result(
        "V4",
        "caught",
        [["testCountActiveBooks", "java.lang.NullPointerException"]],
        "Library.countActive",
      ),
    ]);
    // `lend` is not a word of `Lending`, but `order` is one of `Order`: V2 wins although it fails
    // more tests.
    expect(analysis.failures.get("testListsTitlesInLendingOrder")?.mutant.id).toBe("V2");
    // `countActive` is in the name, but the test's own message tells more than an exception.
    expect(analysis.failures.get("testCountActiveBooks")?.mutant.id).toBe("V3");
  });

  test("shows a variant's message, or else the template's", () => {
    const analysis = analyseMutants([
      result("V1", "caught", [["testPrice", "AssertionFailedError: expected: <3> but was: <0>"]]),
    ]);
    const overview = testOverview(
      [{ title: "Price", tests: ["testPrice", "testNames"] }],
      [
        { name: "testPrice", message: "java.lang.UnsupportedOperationException: Not implemented" },
        { name: "testNames", message: "java.lang.UnsupportedOperationException: Not implemented" },
        { name: "testClass[Shop]", message: "AssertionFailedError: The class Shop is missing." },
      ],
      analysis,
    );
    expect(overview).toEqual([
      {
        task: "Price",
        tests: [
          {
            name: "testPrice",
            message: "expected: <3> but was: <0>",
            generic: true,
            variant: "variant V1",
          },
          {
            name: "testNames",
            message: "UnsupportedOperationException: Not implemented",
            generic: false,
          },
        ],
      },
      {
        task: null,
        tests: [
          {
            name: "testClass[Shop]",
            message: "The class Shop is missing.",
            generic: false,
          },
        ],
      },
    ]);
  });
});

/** A backend that passes every test, except that a variant whose source says `FAIL` fails `t1`. */
class FakeBackend implements BuildBackend {
  readonly id = "fake";
  builds = 0;
  constructor(private readonly behaviour: (source: string) => SubmissionBuild | "hang" | "crash") {}
  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    this.builds += 1;
    const lane = async (files: BundleFile[]): Promise<SubmissionBuild> => {
      const outcome = this.behaviour(files.map((file) => file.content).join("\n"));
      if (outcome === "crash") throw new Error("the build tool is missing");
      if (outcome === "hang") {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
      return outcome as SubmissionBuild;
    };
    return {
      template: await lane(job.bundle.template),
      solution: await lane(job.bundle.solution),
      attestation: {
        backend_id: this.id,
        artemis_revision: null,
        build_agent_image: null,
        build_script_revision: null,
        toolchain: null,
        build_phase_scripts: [],
        build_branch: null,
        unattested: [],
      },
    };
  }
}

const build = (cases: Array<[string, boolean, string?]>, compiled = true): SubmissionBuild => ({
  compiled,
  tests_executed: compiled,
  test_cases: cases.map(([name, passed, message]) => ({
    name,
    passed,
    ...(message === undefined ? {} : { message }),
  })),
  coverage: null,
  diagnostics: [],
});

describe("running the variants", () => {
  const variants = ["FAIL", "PASS", "BROKEN", "PARTIAL", "FAIL"].map((marker, index) => ({
    ...mutant(`V${index + 1}`),
    start: 0,
    end: 0,
    replacement: `${marker}\n`,
  }));
  const job = {
    request: {} as BuildJob["request"],
    bundle: {
      statement: "",
      template: [bundleFile(PATH, "template")],
      solution: [bundleFile(PATH, "solution")],
      tests: [],
    } as unknown as BuildJob["bundle"],
  };
  const behaviour = (source: string): SubmissionBuild | "hang" | "crash" => {
    if (source.startsWith("FAIL"))
      return build([
        ["t1", false, "t1 broke ==> expected"],
        ["t2", true],
      ]);
    if (source.startsWith("BROKEN")) return build([], false);
    if (source.startsWith("PARTIAL")) return build([["t1", false, "t1 broke"]]);
    if (source.startsWith("HANG")) return "hang";
    if (source.startsWith("CRASH")) return "crash";
    return build([
      ["t1", true],
      ["t2", true],
    ]);
  };

  test("tests two variants per build, discards those that do not compile, and counts unfinished tests as caught", async () => {
    const backend = new FakeBackend(behaviour);
    const results = await runMutants(backend, job, variants, {
      expected: ["t1", "t2"],
      concurrency: 2,
    });
    expect(backend.builds).toBe(3);
    expect(results.map((result) => [result.mutant.id, result.status])).toEqual([
      ["V1", "caught"],
      ["V2", "survived"],
      ["V3", "discarded"],
      ["V4", "caught"],
      ["V5", "caught"],
    ]);
  });

  test("keeps a build timeout separate from test rejection, and stops on infrastructure failure", async () => {
    const hang = [{ ...variants[0], replacement: "HANG\n" } as Mutant];
    const results = await runMutants(new FakeBackend(behaviour), job, hang, {
      expected: ["t1"],
      timeoutMs: 20,
    });
    expect(results.map((result) => result.status)).toEqual(["timed_out"]);
    const crash = [{ ...variants[0], replacement: "CRASH\n" } as Mutant];
    await expect(
      runMutants(new FakeBackend(behaviour), job, crash, { expected: ["t1"] }),
    ).rejects.toThrow("the build tool is missing");
  });

  test("runs each variant of a pair that times out again alone", async () => {
    const backend = new FakeBackend(behaviour);
    const pair = [
      { ...variants[0], replacement: "HANG\n" } as Mutant,
      { ...variants[1], replacement: "PASS\n" } as Mutant,
    ];
    const results = await runMutants(backend, job, pair, { expected: ["t1", "t2"], timeoutMs: 20 });
    // Retry the pair separately; a build timeout is not proof of a failed assertion.
    expect(backend.builds).toBe(3);
    expect(results.map((result) => [result.mutant.id, result.status])).toEqual([
      ["V1", "timed_out"],
      ["V2", "survived"],
    ]);
  });
});

describe("findings and metrics for Part D", () => {
  const score = (metric_id: string, fields: Partial<EvaluationScore>): EvaluationScore => ({
    metric_id,
    metric_version: "1",
    status: "ok",
    evidence: [],
    ...fields,
  });
  const responses = [
    {
      evaluator: { id: "java-oracle" },
      scores: [
        score("oracle.satisfied", { value: true }),
        score("coverage.statement", { value: 1 }),
      ],
    },
    {
      evaluator: { id: "java-static" },
      scores: [
        score("complexity.cyclomatic_max", { value: 5 }),
        score("complexity.cognitive_max", { value: 4 }),
      ],
    },
    {
      evaluator: { id: "promise-traceability" },
      scores: [
        score("promise.witnessed_ratio", {
          value: 0.5,
          evidence: [
            'UNWITNESSED no_mutation — "You never modify a Book." — no assertion re-reads it',
            'witnessed empty_input — "An empty list yields 0L." — a test asserts on it',
          ],
        }),
        score("tests.assertion_density", { value: 1.9 }),
        score("tests.assertions", { value: 19 }),
        score("tests.behavioural_methods", { value: 10 }),
      ],
    },
    {
      evaluator: { id: "java-reference" },
      scores: [score("oracle.satisfied", { value: false })],
    },
  ];
  const tests = [
    {
      task: "Price",
      tests: [
        { name: "testPrice", message: "expected: <3>", generic: true, variant: "V1" },
        { name: "testNames", message: "Not implemented", generic: false },
      ],
    },
    { task: "Names", tests: [{ name: "testA", message: "a ==> b", generic: false }] },
    { task: null, tests: [{ name: "hidden", message: "h ==> b", generic: false }] },
  ];

  test("show test sensitivity without treating raw complexity and assertion counts as defects", () => {
    const findings = automaticFindings(responses, tests, {
      ran: 12,
      caught: 11,
      survivors: [mutant("V7")],
    });
    expect(findings.metrics.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Modified solutions rejected by tests", value: "11 of 12" },
    ]);
    expect(findings.items).toHaveLength(1);
    expect(findings.items[0]).toMatchObject({
      id: "F1",
      category: "Test adequacy",
      title: "Tests also pass after these code changes",
    });
    expect(findings.items[0]?.details[0]).toBe("variant V7");
  });

  test("leave out what was not measured, and read the gates from the java-oracle alone", () => {
    const findings = automaticFindings(
      [
        {
          evaluator: { id: "java-static" },
          scores: [score("complexity.cognitive_max", { value: 1 })],
        },
      ],
      [{ task: null, tests: [{ name: "t", message: "m ==> x", generic: false }] }],
      { ran: 0, caught: 0, survivors: [] },
    );
    expect(findings.metrics.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Modified solutions rejected by tests", value: "No completed probes" },
    ]);
    expect(oracleGatesPassed(responses)).toBe(true);
    expect(oracleGatesPassed(responses.slice(1))).toBeUndefined();
    expect(
      automaticFindings(
        [
          {
            evaluator: { id: "promise-traceability" },
            scores: [score("tests.assertion_density", { value: 1 })],
          },
        ],
        [{ task: "T", tests: [{ name: "t", message: "", generic: true }] }],
      ).metrics,
    ).toEqual([{ label: "Code-change probes", value: "Not measured by this build backend" }]);
  });
});
