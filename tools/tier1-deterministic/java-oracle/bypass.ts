import type { BundleFile } from "../../kit/bundle.ts";
import { changedSources, javaClassName } from "../../kit/changes.ts";
import { analyseJavaUnit } from "../../kit/java/structure.ts";
import { groovyClassLiteral } from "./mutation.ts";

/**
 * The output-only bypass probe: does a submission that only prints the reference solution's output
 * pass the graded tests? It applies when a class the student writes declares `main` and the tests
 * call that `main`, the usual shape of a test that compares printed output. The probe runs the
 * solution's `main` once with no arguments and empty standard input, then replaces only the body of
 * that `main` with a print of the captured transcript; every other member stays as in the solution
 * so the class still compiles. Passing every gradable test this way means the tests do not tell a
 * working program from a hard-coded transcript.
 */

/** Large enough for any console exercise, small enough for one Java string constant. */
export const MAXIMUM_TRANSCRIPT_CHARACTERS = 16 * 1024;

const TEST_SOURCE = /^tests?\/|(^|\/)src\/test\//;

export interface MainProbe {
  /** Fully qualified name of the class whose `main` the tests call. */
  className: string;
  /** Path of its source in the solution. */
  path: string;
}

function declaresMain(path: string, content: string): boolean {
  let unit;
  try {
    unit = analyseJavaUnit(path, content);
  } catch {
    return false;
  }
  return unit.tokens.some((token, index) => {
    if (token.value !== "main" || unit.tokens[index - 1]?.value !== "void") return false;
    if (unit.tokens[index + 1]?.value !== "(") return false;
    const modifiers: string[] = [];
    for (let back = index - 2; back >= 0; back--) {
      const value = unit.tokens[back]?.value ?? "";
      if (value === ";" || value === "{" || value === "}") break;
      modifiers.push(value);
    }
    return modifiers.includes("static") && modifiers.includes("public");
  });
}

/** The class to probe, or why the probe does not apply. */
export function findMainProbe(
  template: BundleFile[],
  solution: BundleFile[],
  tests: BundleFile[],
): MainProbe | { unavailable: string } {
  const candidates = changedSources(template, solution).filter(
    (change) =>
      change.after !== undefined &&
      change.path.endsWith(".java") &&
      !TEST_SOURCE.test(change.path) &&
      declaresMain(change.path, change.after),
  );
  if (candidates.length === 0) {
    return {
      unavailable: "no class the solution adds or changes declares public static void main",
    };
  }
  const testSource = tests
    .filter((file) => file.path.endsWith(".java"))
    .map((file) => file.content)
    .join("\n");
  const called = candidates.find((change) => {
    const simple = (change.path.split("/").at(-1) ?? "").replace(/\.java$/, "");
    return new RegExp(`\\b${simple}\\.main\\s*\\(`).test(testSource);
  });
  if (called === undefined) {
    return { unavailable: "no test calls the main method of a class the solution changes" };
  }
  if (
    solution.some(
      (file) => file.path.endsWith(".java") && /\bSystem\s*\.\s*in\b/.test(file.content),
    )
  ) {
    return {
      unavailable: "the solution reads standard input, so one transcript cannot stand for it",
    };
  }
  return { className: javaClassName(called.path, called.after ?? ""), path: called.path };
}

/** A Java string literal for any text, with every non-ASCII code unit as a Unicode escape. */
export function javaStringLiteral(text: string): string {
  let literal = '"';
  for (const character of text) {
    for (let index = 0; index < character.length; index++) {
      const code = character.charCodeAt(index);
      if (character === '"') literal += '\\"';
      else if (character === "\\") literal += "\\\\";
      else if (character === "\n") literal += "\\n";
      else if (character === "\r") literal += "\\r";
      else if (character === "\t") literal += "\\t";
      else if (code < 0x20 || code > 0x7e) literal += `\\u${code.toString(16).padStart(4, "0")}`;
      else literal += character;
    }
  }
  return `${literal}"`;
}

/** The class source with only the body of its `main` replaced by a print of the transcript. */
export function hardCodedMain(path: string, source: string, transcript: string): string | null {
  const unit = analyseJavaUnit(path, source);
  const simple = (path.split("/").at(-1) ?? "").replace(/\.java$/, "");
  const main = unit.methods.find(
    (method) =>
      method.name === "main" &&
      method.parameterCount === 1 &&
      method.typeName === simple &&
      method.bodyStart !== null &&
      method.bodyEnd !== null,
  );
  const open = main?.bodyStart === null ? undefined : unit.tokens[main?.bodyStart ?? -1];
  const close = main?.bodyEnd === null ? undefined : unit.tokens[main?.bodyEnd ?? -1];
  if (open === undefined || close === undefined) return null;
  return `${source.slice(0, open.end)}\n        System.out.print(${javaStringLiteral(transcript)});\n    ${source.slice(close.start)}`;
}

/**
 * Registers `exgenRunMain`, which runs a class's `main` with no arguments, empty standard input and
 * a time limit, and writes its standard output and exit value under `build/exgen-main/`.
 */
export function runMainInitScript(className: string, timeoutSeconds: number): string {
  const literal = groovyClassLiteral(className);
  return `allprojects { p ->
 p.plugins.withId('java') {
  p.tasks.register('exgenRunMain', JavaExec) {
   classpath = p.sourceSets.main.runtimeClasspath
   mainClass = ${literal}
   jvmArgs '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'
   standardInput = new ByteArrayInputStream(new byte[0])
   ignoreExitValue = true
   timeout = java.time.Duration.ofSeconds(${timeoutSeconds})
   def output = p.layout.buildDirectory.dir('exgen-main').get().asFile
   doFirst {
    output.mkdirs()
    standardOutput = new FileOutputStream(new File(output, 'stdout.txt'))
   }
   doLast {
    standardOutput.close()
    new File(output, 'exit.txt').text = executionResult.get().exitValue.toString()
   }
  }
 }
}
`;
}
