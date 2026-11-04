import { DOMParser, type Element } from "@xmldom/xmldom";

import type { BundleFile } from "../../kit/bundle.ts";
import { javaTypeNames } from "../../kit/changes.ts";
import type { Mutant } from "./backend.ts";

/**
 * PIT, pinned so a mutation score is attributable to a known mutation engine and operator set. The
 * Gradle plugin is applied from an init script, so the candidate's build script keeps its own
 * plugin block; only the Ares hooks below are removed, and only in the copy PIT runs in.
 */
export const PIT_VERSION = "1.30.0";
export const PIT_GRADLE_PLUGIN_VERSION = "1.19.0";
export const PIT_JUNIT5_PLUGIN_VERSION = "1.2.3";
export const PIT_TOOL = `pitest ${PIT_VERSION} (DEFAULTS mutators, gradle-pitest-plugin ${PIT_GRADLE_PLUGIN_VERSION}, pitest-junit5-plugin ${PIT_JUNIT5_PLUGIN_VERSION})`;

/** Ares 1 installs a security manager from the test annotations, which denies PIT's minion. */
const ARES_1 = /\bde\.tum\.in\.test\.api\b|artemis-java-test-sandbox/;

const ARES_2_HOOKS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "the AspectJ post-compile weaving plugin",
    pattern: /^[ \t]*id[ \t(]+['"]io\.freefair\.aspectj\.post-compile-weaving['"].*$/gm,
    replacement: "",
  },
  {
    // The aspect path is also on the submission's compile classpath, which brings JUnit with Ares;
    // exercises whose students write tests in their own sources compile against it.
    name: "the Ares aspect dependency, kept as compileOnly",
    pattern: /^([ \t]*)aspect([ \t(]+['"]de\.tum\.cit\.ase:ares[^'"]*['"].*)$/gm,
    replacement: "$1compileOnly$2",
  },
  {
    name: "the Ares Java agent arguments of the test tasks",
    pattern:
      /tasks\.withType\(Test\)\.configureEach\s*\{\s*jvmArgumentProviders\.add\(aresJvmArguments\)\s*\}/g,
    replacement: "",
  },
];

/**
 * What would still install an agent into a test JVM, or weave aspects into the submission, once the
 * hooks are removed, by name for the refusal message.
 */
const ARES_2_REMNANTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "a JVM argument provider", pattern: /\bjvmArgumentProviders\b/ },
  { name: "a -javaagent argument", pattern: /-javaagent/ },
  { name: "an AspectJ plugin", pattern: /io\.freefair\.aspectj|['"]aspectj['"]/ },
  { name: "an aspect or inpath dependency", pattern: /^[ \t]*(aspect|inpath)[ \t(]/m },
  {
    name: "another use of aresJvmArguments",
    pattern:
      /\baresJvmArguments\b(?!\s*=\s*objects\.newInstance\(|\.(agentJar|aspectjRuntimeJar)\.from\()/,
  },
  { name: "a script applied from a URL", pattern: /apply\s*\(?\s*from\s*:\s*['"]?\s*\w+:\/\// },
];

/**
 * The script without the bodies of argument-provider classes: the Ares provider spells out
 * `-javaagent`, which is harmless once nothing attaches the provider to a task.
 */
function withoutProviderClasses(script: string): string {
  const declaration = /class\s+\w+\s+implements\s+CommandLineArgumentProvider\s*\{/g;
  let result = script;
  for (let match = declaration.exec(result); match !== null; match = declaration.exec(result)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < result.length && depth > 0; end++) {
      if (result[end] === "{") depth++;
      if (result[end] === "}") depth--;
    }
    result = result.slice(0, match.index) + result.slice(end);
    declaration.lastIndex = match.index;
  }
  return result;
}

function aresRemnant(script: string): string | null {
  const scanned = withoutProviderClasses(script);
  return ARES_2_REMNANTS.find((remnant) => remnant.pattern.test(scanned))?.name ?? null;
}

export type AresFreeBuild =
  { ok: true; script: string; removed: string[] } | { ok: false; reason: string };

/**
 * The test repository's build script without the Ares 2 hooks: the Java agent and its arguments on
 * test tasks, the AspectJ post-compile weaving plugin and the aspect dependency that weaves Ares
 * into the submission, which becomes a compile-only dependency so the submission compiles against
 * the same classpath as in the graded build. Ares stays a test dependency, so `@Policy` and the other annotations still
 * compile; without the agent they enforce nothing, which is what lets PIT's minion run. A build
 * this cannot clean completely is refused rather than half patched.
 */
export function aresFreeBuildScript(script: string, tests: BundleFile[]): AresFreeBuild {
  if (ARES_1.test(script) || tests.some((file) => ARES_1.test(file.content))) {
    return {
      ok: false,
      reason:
        "the tests use Ares 1 (de.tum.in.test.api), whose security manager denies PIT's minion; " +
        "only Ares 2 hooks can be removed from the build",
    };
  }
  let patched = script;
  const removed: string[] = [];
  for (const hook of ARES_2_HOOKS) {
    const next = patched.replace(hook.pattern, hook.replacement);
    if (next !== patched) removed.push(hook.name);
    patched = next;
  }
  // Every other Gradle script of the test repository, including those `apply from` loads, runs
  // unpatched in the PIT copy, so none of them may attach an agent or weave either.
  const scripts = [
    { path: "build.gradle", content: patched },
    ...tests.filter((file) => file.path !== "build.gradle" && /\.gradle(\.kts)?$/.test(file.path)),
  ];
  for (const { path, content } of scripts) {
    const remnant = aresRemnant(content);
    if (remnant !== null) {
      return {
        ok: false,
        reason: `${path} still installs ${remnant} once the recognised Ares hooks are removed`,
      };
    }
  }
  return { ok: true, script: patched, removed };
}

/** A qualified Java class name, Unicode identifiers included; nothing else reaches a script. */
const IDENTIFIER = String.raw`[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}]*`;
const CLASS_NAME = new RegExp(String.raw`^${IDENTIFIER}(\.${IDENTIFIER})*$`, "u");

export function isClassName(name: string): boolean {
  return CLASS_NAME.test(name);
}

/**
 * A class name, or a PIT glob built from one, as a Groovy single-quoted string. Every character
 * outside printable ASCII becomes a `\uXXXX` escape, so the script means the same whatever encoding
 * Gradle reads it in; a validated class name contains no quote or backslash.
 */
function groovyString(text: string): string {
  let literal = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    literal += code < 0x7f ? text[index] : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `'${literal}'`;
}

export function groovyClassLiteral(name: string): string {
  if (!isClassName(name)) throw new Error(`not a Java class name: ${name}`);
  return groovyString(name);
}

export function testClassNames(tests: BundleFile[]): string[] {
  return [
    ...new Set(
      tests
        .filter((file) => file.path.endsWith(".java"))
        .flatMap((file) => javaTypeNames(file.path, file.content)),
    ),
  ].sort();
}

/**
 * An init script that applies PIT to the build without editing it. Each target class also matches
 * its nested and anonymous classes. The tests to run are named explicitly: the plugin otherwise
 * looks for tests among the target classes, finds none, and reports every mutant as uncovered.
 */
export function pitInitScript(targetClasses: string[], targetTests: string[]): string {
  const targets = targetClasses.flatMap((name) => [
    groovyClassLiteral(name),
    groovyString(`${name}$*`),
  ]);
  // A test class whose name is no class name cannot hold tests; it is left out, not the whole pass.
  targetTests = targetTests.filter(isClassName);
  return `initscript {
 repositories { gradlePluginPortal() }
 dependencies { classpath 'info.solidsoft.gradle.pitest:gradle-pitest-plugin:${PIT_GRADLE_PLUGIN_VERSION}' }
}
allprojects { p ->
 p.plugins.withId('java') {
  p.apply plugin: info.solidsoft.gradle.pitest.PitestPlugin
  p.pitest {
   pitestVersion = '${PIT_VERSION}'
   junit5PluginVersion = '${PIT_JUNIT5_PLUGIN_VERSION}'
   targetClasses = [${targets.join(", ")}]
   targetTests = [${targetTests.map(groovyClassLiteral).join(", ")}]
   mutators = ['DEFAULTS']
   outputFormats = ['XML']
   timestampedReports = false
   threads = 2
   timeoutConstInMillis = 4000
   failWhenNoMutations = false
  }
 }
}
`;
}

const text = (element: Element, name: string): string =>
  element.getElementsByTagName(name)[0]?.textContent?.trim() ?? "";

/** PIT's XML report as mutants; null when the document is not a PIT report. */
export function parsePitReport(xml: string): Mutant[] | null {
  if (/<!DOCTYPE/i.test(xml)) return null;
  const document = new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
  if (document.documentElement?.tagName !== "mutations") return null;
  return Array.from(document.getElementsByTagName("mutation")).map((mutation) => ({
    class: text(mutation, "mutatedClass"),
    method: text(mutation, "mutatedMethod"),
    line: Number(text(mutation, "lineNumber")) || 0,
    mutator: text(mutation, "mutator").split(".").at(-1) ?? "",
    status: mutation.getAttribute("status") ?? "",
  }));
}

/** Detected: the tests failed, ran out of time or out of memory under the mutant. */
const DETECTED = new Set(["KILLED", "TIMED_OUT", "MEMORY_ERROR"]);
/** Not a test outcome: the mutant could not be loaded or its run crashed. */
const EXCLUDED = new Set(["NON_VIABLE", "RUN_ERROR"]);
/** Undetected: a test ran the mutant and passed, or no test reached it. */
const UNDETECTED = new Set(["SURVIVED", "NO_COVERAGE"]);

export interface MutationSummary {
  /** Mutants of the changed classes, by PIT status. */
  counts: Record<string, number>;
  killed: number;
  denominator: number;
  survivors: Mutant[];
  coveredSurvivors: number;
  /** Statuses that mean the run did not finish, such as NOT_STARTED. */
  unfinished: number;
}

/** The outer class a mutant belongs to, so nested and anonymous classes count as their file's. */
export function outerClass(name: string): string {
  return name.split("$")[0] ?? name;
}

/**
 * The study's mutation score: detected mutants over every mutant of the changed classes except
 * those that are not viable or whose run failed. A mutant no test reaches counts as surviving.
 */
export function summariseMutants(mutants: Mutant[], targetClasses: string[]): MutationSummary {
  const targets = new Set(targetClasses);
  const scoped = mutants.filter((mutant) => targets.has(outerClass(mutant.class)));
  const counts: Record<string, number> = {};
  for (const mutant of scoped) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  const survivors = scoped.filter((mutant) => UNDETECTED.has(mutant.status));
  return {
    counts,
    killed: scoped.filter((mutant) => DETECTED.has(mutant.status)).length,
    denominator: scoped.filter((mutant) => !EXCLUDED.has(mutant.status)).length,
    survivors,
    coveredSurvivors: survivors.filter((mutant) => mutant.status === "SURVIVED").length,
    unfinished: scoped.filter(
      (mutant) =>
        !DETECTED.has(mutant.status) &&
        !EXCLUDED.has(mutant.status) &&
        !UNDETECTED.has(mutant.status),
    ).length,
  };
}
