import type { BundleFile } from "../../kit/bundle.ts";
import { changedSources, javaTypeNames } from "../../kit/changes.ts";
import { analyseJavaUnit, type JavaUnit } from "../../kit/java/structure.ts";
import { groovyClassLiteral } from "./mutation.ts";

/**
 * The output-only bypass probe: does a submission that only prints the reference solution's output
 * pass the graded tests? It applies when a class the student writes declares `main` and the tests
 * observe that `main` by execution. Direct calls prioritize a candidate, but reflection and indirect
 * dispatch do not exclude it. The probe runs the
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
  /** Its simple name, which declares the `main` to replace. */
  typeName: string;
  /** Path of its source in the solution. */
  path: string;
}

function lex(path: string, content: string): JavaUnit | null {
  try {
    return analyseJavaUnit(path, content);
  } catch {
    return null;
  }
}

/** The top-level types of a source that declare `public static void main` with one parameter. */
function typesDeclaringMain(path: string, content: string): string[] {
  const unit = lex(path, content);
  if (unit === null) return [];
  const topLevel = new Set(javaTypeNames(path, content).map((name) => name.split(".").at(-1)));
  const declaring = new Set<string>();
  unit.tokens.forEach((token, index) => {
    if (token.value !== "main" || unit.tokens[index - 1]?.value !== "void") return;
    if (unit.tokens[index + 1]?.value !== "(") return;
    const modifiers: string[] = [];
    for (let back = index - 2; back >= 0; back--) {
      const value = unit.tokens[back]?.value ?? "";
      if (value === ";" || value === "{" || value === "}") break;
      modifiers.push(value);
    }
    if (!modifiers.includes("static") || !modifiers.includes("public")) return;
    const method = unit.methods.find(
      (candidate) =>
        candidate.name === "main" &&
        candidate.parameterCount === 1 &&
        candidate.bodyStart !== null &&
        candidate.bodyStart > index,
    );
    if (method?.typeName && topLevel.has(method.typeName)) declaring.add(method.typeName);
  });
  return [...declaring];
}

/** The simple names whose `main` a test calls as `Name.main(`, read from tokens. */
function calledMains(tests: BundleFile[]): Set<string> {
  const called = new Set<string>();
  for (const file of tests.filter((candidate) => candidate.path.endsWith(".java"))) {
    const tokens = lex(file.path, file.content)?.tokens ?? [];
    tokens.forEach((token, index) => {
      if (
        token.kind === "identifier" &&
        tokens[index + 1]?.value === "." &&
        tokens[index + 2]?.value === "main" &&
        tokens[index + 3]?.value === "("
      ) {
        called.add(token.value);
      }
    });
  }
  return called;
}

/** `System.in` in code, never in a comment or string; a source that cannot be lexed counts. */
function readsStandardInput(file: BundleFile): boolean {
  const tokens = lex(file.path, file.content)?.tokens;
  if (tokens === undefined) return true;
  return tokens.some(
    (token, index) =>
      token.value === "System" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "in" &&
      tokens[index + 2]?.kind === "identifier",
  );
}

/** The class to probe, or why the probe does not apply. */
export function findMainProbe(
  template: BundleFile[],
  solution: BundleFile[],
  tests: BundleFile[],
): MainProbe | { unavailable: string } {
  const candidates = changedSources(template, solution).flatMap((change) =>
    change.after === undefined || !change.path.endsWith(".java") || TEST_SOURCE.test(change.path)
      ? []
      : typesDeclaringMain(change.path, change.after).map((typeName) => ({
          path: change.path,
          content: change.after ?? "",
          typeName,
        })),
  );
  if (candidates.length === 0) {
    return {
      unavailable: "no class the solution adds or changes declares public static void main",
    };
  }
  const called = calledMains(tests);
  const probed = candidates.find((candidate) => called.has(candidate.typeName)) ?? candidates[0];
  if (probed === undefined) throw new Error("the changed main candidate disappeared");
  if (solution.some((file) => file.path.endsWith(".java") && readsStandardInput(file))) {
    return {
      unavailable: "the solution reads standard input, so one transcript cannot stand for it",
    };
  }
  const className = javaTypeNames(probed.path, probed.content).find(
    (name) => name.split(".").at(-1) === probed.typeName,
  );
  return { className: className ?? probed.typeName, typeName: probed.typeName, path: probed.path };
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

/** The source with only the body of `typeName`'s `main` replaced by a print of the transcript. */
export function hardCodedMain(
  path: string,
  source: string,
  transcript: string,
  typeName: string,
): string | null {
  const unit = lex(path, source);
  if (unit === null) return null;
  const main = unit.methods.find(
    (method) =>
      method.name === "main" &&
      method.parameterCount === 1 &&
      method.typeName === typeName &&
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
 * a time limit, and writes its standard output and exit value under `build/exgen-main/`. At most
 * `maximumOutputBytes` of output are kept, so a `main` that prints without end cannot fill the disk.
 */
export function runMainInitScript(
  className: string,
  timeoutSeconds: number,
  maximumOutputBytes: number,
): string {
  const literal = groovyClassLiteral(className);
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1) {
    throw new Error(`not a byte limit: ${maximumOutputBytes}`);
  }
  return `class ExgenCappedOutput extends OutputStream {
 private final OutputStream target
 private long left
 ExgenCappedOutput(OutputStream target, long limit) { this.target = target; this.left = limit }
 void write(int b) { if (left > 0) { target.write(b); left-- } }
 void write(byte[] b, int off, int len) {
  int kept = (int) Math.min((long) len, Math.max(0L, left))
  if (kept > 0) { target.write(b, off, kept); left -= kept }
 }
 void flush() { target.flush() }
 void close() { target.close() }
}
allprojects { p ->
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
    standardOutput = new ExgenCappedOutput(new FileOutputStream(new File(output, 'stdout.txt')), ${maximumOutputBytes}L)
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
