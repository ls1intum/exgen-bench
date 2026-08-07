import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { rejectSymlinkComponents, resolveContained } from "../../src/adapters/paths.ts";
import { readTextBounded } from "../../src/core/files.ts";

// A narrow projection of response.json, so the evaluator survives harness contract revisions.
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

export interface CandidateBundle {
  problemStatement: string;
  testFiles: SourceFile[];
}

/** A candidate the evaluator cannot read. Never an infrastructure failure: the bundle is the thing
 * under measurement, so a malformed one is a quality outcome and must not be retried. */
export class BundleIncomplete extends Error {
  override readonly name = "BundleIncomplete";
}

async function collect(
  root: string,
  current: string,
  depth: number,
  budget: { files: number; bytes: number },
  files: SourceFile[],
): Promise<void> {
  if (depth > MAXIMUM_DEPTH) {
    throw new BundleIncomplete(`test tree exceeds depth ${MAXIMUM_DEPTH}`);
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
      throw new BundleIncomplete(`test tree exceeds ${MAXIMUM_SOURCE_FILES} Java files`);
    }
    const size = (await stat(child)).size;
    budget.bytes += size;
    if (budget.bytes > MAXIMUM_SOURCE_BYTES) {
      throw new BundleIncomplete(`test tree exceeds ${MAXIMUM_SOURCE_BYTES} bytes`);
    }
    files.push({
      path: relative(root, child).split(sep).join("/"),
      text: await readTextBounded(child, MAXIMUM_SOURCE_BYTES),
    });
  }
}

export async function readCandidateBundle(bundlePath: string): Promise<CandidateBundle> {
  let response: unknown;
  try {
    response = JSON.parse(
      await readTextBounded(join(bundlePath, "response.json"), MAXIMUM_RESPONSE_BYTES),
    );
  } catch (error) {
    throw new BundleIncomplete(
      `candidate bundle has no readable response.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = artifactRolesSchema.safeParse(response);
  if (!parsed.success) {
    throw new BundleIncomplete("candidate response.json declares no artifact roles");
  }
  const byRole = new Map(parsed.data.artifacts.map((artifact) => [artifact.role, artifact.path]));
  const statementPath = byRole.get("problem_statement");
  const testsPath = byRole.get("tests");
  if (statementPath === undefined || testsPath === undefined) {
    throw new BundleIncomplete("candidate declares no problem_statement or tests artifact");
  }

  let statementFile: string;
  let testsRoot: string;
  try {
    statementFile = resolveContained(bundlePath, statementPath, "artifact");
    testsRoot = resolveContained(bundlePath, testsPath, "artifact");
    await rejectSymlinkComponents(bundlePath, statementFile, "artifact");
    await rejectSymlinkComponents(bundlePath, testsRoot, "artifact");
  } catch (error) {
    throw new BundleIncomplete(
      `candidate declares an unsafe artifact path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const problemStatement = await readTextBounded(statementFile, MAXIMUM_SOURCE_BYTES);
  if (problemStatement.trim() === "") {
    throw new BundleIncomplete("problem statement is empty");
  }
  const testFiles: SourceFile[] = [];
  await collect(testsRoot, testsRoot, 0, { files: 0, bytes: 0 }, testFiles);
  if (testFiles.length === 0) {
    throw new BundleIncomplete("tests artifact contains no Java sources");
  }
  testFiles.sort((left, right) => left.path.localeCompare(right.path));
  return { problemStatement, testFiles };
}
