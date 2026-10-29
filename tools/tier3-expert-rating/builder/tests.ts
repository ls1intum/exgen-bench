import type { Exercise } from "../shared/exercise.ts";
import type { MutationAnalysis } from "./mutation.ts";
import type { Task } from "./statement.ts";

export interface TestResult {
  name: string;
  message?: string | undefined;
}

/** `org.opentest4j.AssertionFailedError: text`: an exception's class, then its message if it has one. */
const THROWABLE =
  /^((?:[a-zA-Z_$][\w$]*\.)*[A-Z][\w$]*(?:Error|Exception|Throwable|Failure))(?::\s*([\s\S]*))?$/;

/** Assertion failures, as JUnit, opentest4j and the JDK name them. */
const ASSERTION = /(AssertionFailedError|AssertionError|ComparisonFailure|MultipleFailuresError)$/;

/**
 * The text of an assertion that carries no message of its own: JUnit's default texts for
 * `assertEquals`, `assertThrows`, `assertDoesNotThrow`, `assertInstanceOf`, `assertArrayEquals` and
 * `assertIterableEquals`, and AssertJ's. With a message, JUnit prefixes it (`message ==> expected:
 * …`), so only a bare assertion starts like this.
 */
const BARE_ASSERTION =
  /^(expected:|expected <|expecting|Expected \S+ to be thrown, but nothing was thrown|Unexpected exception type thrown,|Unexpected exception thrown:|Unexpected type, expected:|Unexpected null value|array contents differ at index|iterable contents differ at index)/i;

/**
 * A test stopped for taking too long says nothing about what is wrong. It is recognised by the
 * class it is reported under (`java.util.concurrent.TimeoutException`), or by the exact text
 * JUnit and Ares stop it with, never by a test's own message that mentions a timeout.
 */
const TIMEOUT_CLASS = /Timeout[\w$]*$/;
const TIMEOUT_TEXT =
  /^(execution timed out after|execution exceeded timeout of|timed out after|[\w$]+\(\) timed out after) /i;

/**
 * What a failure message gives a student: words the test wrote (`own`), only the expected and actual
 * values of an assertion (`bare`), an exception or a timeout (`exception`), or nothing (`none`).
 */
export function failureKind(message: string | undefined): "own" | "bare" | "exception" | "none" {
  let text = message?.trim() ?? "";
  if (text === "") return "none";
  const throwable = THROWABLE.exec(text);
  if (throwable !== null) {
    const name = throwable[1] ?? "";
    if (TIMEOUT_CLASS.test(name) || !ASSERTION.test(name)) return "exception";
    text = throwable[2]?.trim() ?? "";
  }
  if (TIMEOUT_TEXT.test(text)) return "exception";
  return text === "" || BARE_ASSERTION.test(text) ? "bare" : "own";
}

/**
 * A failure message as an instructor reads it: an assertion's own text without the class JUnit
 * reports it under (`org.opentest4j.AssertionFailedError: `), and an exception under its simple
 * name (`NullPointerException: …`), not its package.
 */
export function readable(message: string): string {
  const text = message.trim();
  const throwable = THROWABLE.exec(text);
  if (throwable === null) return text;
  const name = throwable[1] ?? "";
  const rest = throwable[2]?.trim() ?? "";
  if (ASSERTION.test(name) && rest !== "") return rest;
  const simple = name.slice(name.lastIndexOf(".") + 1);
  return rest === "" ? simple : `${simple}: ${rest}`;
}

type Overview = Exercise["tests"];
type TestEntry = Overview[number]["tests"][number];

/**
 * The test overview as students see it in Artemis: each task's tests with the message a failing test
 * shows. Which tests exist comes from running them against the template, which fails every one. The
 * message comes from the wrong variant of the solution that made the test fail most tellingly, when
 * variants ran and one failed it, named as the test's `variant`; otherwise it is the template's.
 * Tests no task lists come last, under no task.
 */
export function testOverview(
  tasks: Task[],
  results: TestResult[],
  mutation?: MutationAnalysis,
): Overview {
  const byName = new Map(results.map((result) => [result.name, result]));
  const used = new Set<string>();
  const entry = (name: string): TestEntry => {
    used.add(name);
    const failure = mutation?.failures.get(name);
    if (failure !== undefined) {
      const kind = failureKind(failure.message);
      return {
        name,
        message: readable(failure.message ?? ""),
        generic: kind === "bare" || kind === "none",
        variant: failure.mutant.description,
      };
    }
    const message = byName.get(name)?.message?.trim() ?? "";
    const kind = failureKind(message);
    return {
      name,
      message: readable(message),
      generic: kind === "bare" || kind === "none",
    };
  };
  const grouped = tasks
    .map((task) => ({
      task: task.title,
      tests: task.tests.filter((name) => byName.has(name)).map(entry),
    }))
    .filter((group) => group.tests.length > 0);
  const missing = tasks.flatMap((task) => task.tests).filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `the statement lists tests the template build did not run: ${missing.join(", ")}`,
    );
  }
  const rest = results
    .filter((result) => !used.has(result.name))
    .map((result) => entry(result.name));
  return rest.length > 0 ? [...grouped, { task: null, tests: rest }] : grouped;
}
