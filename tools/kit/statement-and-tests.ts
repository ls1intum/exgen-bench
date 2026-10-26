import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { rejectSymlinkComponents, resolveContained } from "../../src/adapters/paths.ts";
import { readTextBounded } from "../../src/core/files.ts";
import { BundleError } from "./bundle.ts";

// A narrow projection of response.json, so its readers survive harness contract revisions.
const artifactRolesSchema = z.looseObject({
  artifacts: z.array(z.looseObject({ role: z.string().min(1), path: z.string().min(1) })),
});

const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_SOURCE_FILES = 512;
const MAXIMUM_SOURCE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DEPTH = 32;
const IGNORED_DIRECTORIES = new Set([".git", "target", "build", "node_modules"]);

export interface SourceFile {
  path: string;
  text: string;
}

interface StatementAndTests {
  problemStatement: string;
  testFiles: SourceFile[];
}

function incomplete(message: string): BundleError {
  return new BundleError(message, "candidate.incomplete");
}

async function collect(
  root: string,
  current: string,
  depth: number,
  budget: { files: number; bytes: number },
  files: SourceFile[],
): Promise<void> {
  if (depth > MAXIMUM_DEPTH) {
    throw incomplete(`test tree exceeds depth ${MAXIMUM_DEPTH}`);
  }
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const child = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collect(root, child, depth + 1, budget, files);
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".java")) {
      continue;
    }
    budget.files += 1;
    if (budget.files > MAXIMUM_SOURCE_FILES) {
      throw incomplete(`test tree exceeds ${MAXIMUM_SOURCE_FILES} Java files`);
    }
    const size = (await stat(child)).size;
    budget.bytes += size;
    if (budget.bytes > MAXIMUM_SOURCE_BYTES) {
      throw incomplete(`test tree exceeds ${MAXIMUM_SOURCE_BYTES} bytes`);
    }
    files.push({
      path: relative(root, child).split(sep).join("/"),
      text: await readTextBounded(child, MAXIMUM_SOURCE_BYTES),
    });
  }
}

/** The problem statement and the Java test sources of a candidate, which is all promise traceability reads. */
export async function readStatementAndTests(bundlePath: string): Promise<StatementAndTests> {
  let response: unknown;
  try {
    response = JSON.parse(
      await readTextBounded(join(bundlePath, "response.json"), MAXIMUM_RESPONSE_BYTES),
    );
  } catch (error) {
    throw incomplete(
      `candidate bundle has no readable response.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = artifactRolesSchema.safeParse(response);
  if (!parsed.success) {
    throw incomplete("candidate response.json declares no artifact roles");
  }
  const byRole = new Map(parsed.data.artifacts.map((artifact) => [artifact.role, artifact.path]));
  const statementPath = byRole.get("problem_statement");
  const testsPath = byRole.get("tests");
  if (statementPath === undefined || testsPath === undefined) {
    throw incomplete("candidate declares no problem_statement or tests artifact");
  }

  let statementFile: string;
  let testsRoot: string;
  try {
    statementFile = resolveContained(bundlePath, statementPath, "artifact");
    testsRoot = resolveContained(bundlePath, testsPath, "artifact");
    await rejectSymlinkComponents(bundlePath, statementFile, "artifact");
    await rejectSymlinkComponents(bundlePath, testsRoot, "artifact");
  } catch (error) {
    throw incomplete(
      `candidate declares an unsafe artifact path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const problemStatement = await readTextBounded(statementFile, MAXIMUM_SOURCE_BYTES);
  if (problemStatement.trim() === "") {
    throw incomplete("problem statement is empty");
  }
  const testFiles: SourceFile[] = [];
  await collect(testsRoot, testsRoot, 0, { files: 0, bytes: 0 }, testFiles);
  if (testFiles.length === 0) {
    throw incomplete("tests artifact contains no Java sources");
  }
  testFiles.sort((left, right) => left.path.localeCompare(right.path));
  return { problemStatement, testFiles };
}
