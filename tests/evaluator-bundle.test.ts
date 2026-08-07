import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleError, readCandidateBundle } from "../evaluators/shared/bundle.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A bundle whose four artifact roles point wherever the caller says. */
async function bundleDeclaring(paths: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exgen-bundle-"));
  temporaryDirectories.push(root);
  const bundle = join(root, "bundle");
  await mkdir(bundle, { recursive: true });

  const sealed = join(root, "sealed");
  await mkdir(sealed, { recursive: true });
  await writeFile(join(sealed, "Golden.java"), "class Golden { }\n");
  await writeFile(join(sealed, "statement.md"), "sealed statement\n");
  await symlink(sealed, join(bundle, "hop"));
  await symlink(join(sealed, "statement.md"), join(bundle, "linked.md"));

  await writeFile(join(bundle, "statement.md"), "# Task\n");
  for (const role of ["template", "solution", "tests"]) {
    await mkdir(join(bundle, role), { recursive: true });
    await writeFile(join(bundle, role, "A.java"), "class A { }\n");
  }
  await writeFile(
    join(bundle, "response.json"),
    JSON.stringify({
      protocol_version: "2",
      status: "succeeded",
      artifacts: [
        {
          role: "problem_statement",
          path: paths.problem_statement ?? "statement.md",
          media_type: "text/markdown",
        },
        { role: "template", path: paths.template ?? "template" },
        { role: "solution", path: paths.solution ?? "solution" },
        { role: "tests", path: paths.tests ?? "tests" },
      ],
      capture: { completeness: "complete" },
    }),
  );
  return bundle;
}

describe("candidate bundle containment", () => {
  test("reads the four declared roles", async () => {
    const bundle = await readCandidateBundle(await bundleDeclaring({}));
    expect(bundle.statement).toContain("# Task");
    expect(bundle.solution.map((unit) => unit.path)).toEqual(["A.java"]);
  });

  // The LocalCI backend writes these bytes into Artemis, so an escaped path would put an arbitrary
  // host file on the wire.
  test.each([
    ["a symlinked problem statement", { problem_statement: "linked.md" }],
    ["an artifact root behind a symlinked ancestor", { tests: "hop" }],
    ["a parent traversal", { solution: "../sealed" }],
    ["an absolute path", { template: "/etc" }],
  ])("refuses %s", async (_name, paths) => {
    await expect(readCandidateBundle(await bundleDeclaring(paths))).rejects.toBeInstanceOf(
      BundleError,
    );
  });
});
