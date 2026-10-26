import type { Exercise } from "../shared/exercise.ts";
import type { Task } from "./statement.ts";

export interface TestResult {
  name: string;
  message?: string | undefined;
}

/**
 * JUnit's text for an assertion that carries no message of its own. With a message, JUnit prefixes
 * it (`message ==> expected: …`), so only a bare assertion starts like this.
 */
const BARE_ASSERTION = /^(expected:|expected <|$)/;

/**
 * The test overview as students see it in Artemis: each task's tests with the message a failing
 * test shows, taken from running the tests against the template, which fails every one of them.
 * Tests no task lists come last, under no task.
 */
export function testOverview(tasks: Task[], results: TestResult[]): Exercise["tests"] {
  const byName = new Map(results.map((result) => [result.name, result]));
  const used = new Set<string>();
  const entry = (name: string) => {
    used.add(name);
    const message = byName.get(name)?.message?.trim() ?? "";
    return { name, message, generic: BARE_ASSERTION.test(message) };
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
