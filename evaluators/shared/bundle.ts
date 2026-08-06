import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { generationResponseSchema } from "../../src/contracts.ts";
import { analyseJavaUnit, type JavaUnit } from "./java/structure.ts";

/**
 * Reading a candidate bundle in the Artemis programming-exercise layout.
 *
 * A bundle is the immutable `output/` directory of one attempt: a `response.json` declaring artifact
 * roles, plus the four artifacts the target requires -- a problem statement file and the template,
 * solution and test directories. The reader refuses symbolic links and enforces entry and byte caps,
 * because an evaluator reads generated content and must not be walked out of its own bundle.
 */

export const REQUIRED_ROLES = ["problem_statement", "template", "solution", "tests"] as const;
export type ArtifactRole = (typeof REQUIRED_ROLES)[number];

const MAXIMUM_ENTRIES = 4_000;
const MAXIMUM_BYTES = 64 * 1024 * 1024;

export interface BundleFile {
  /** Path relative to the artifact root, always with forward slashes. */
  path: string;
  content: string;
  bytes: number;
}

export interface CandidateBundle {
  root: string;
  statement: string;
  statementPath: string;
  template: BundleFile[];
  solution: BundleFile[];
  tests: BundleFile[];
}

export class BundleError extends Error {}

async function readTree(
  root: string,
  budget: { entries: number; bytes: number },
): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const walk = async (current: string): Promise<void> => {
    budget.entries += 1;
    if (budget.entries > MAXIMUM_ENTRIES) {
      throw new BundleError(`bundle exceeds ${MAXIMUM_ENTRIES} entries`);
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new BundleError(`bundle contains a symbolic link: ${relative(root, current)}`);
    }
    if (metadata.isFile()) {
      budget.bytes += metadata.size;
      if (budget.bytes > MAXIMUM_BYTES) {
        throw new BundleError(`bundle exceeds ${MAXIMUM_BYTES} bytes`);
      }
      files.push({
        path: relative(root, current).split(sep).join("/"),
        content: await readFile(current, "utf8"),
        bytes: metadata.size,
      });
      return;
    }
    if (!metadata.isDirectory()) {
      throw new BundleError(`bundle entry is neither a file nor a directory: ${current}`);
    }
    for (const entry of (await readdir(current)).sort()) {
      await walk(join(current, entry));
    }
  };
  await walk(root);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function readCandidateBundle(bundlePath: string): Promise<CandidateBundle> {
  let response: unknown;
  try {
    response = JSON.parse(await readFile(join(bundlePath, "response.json"), "utf8"));
  } catch (error) {
    throw new BundleError(
      `bundle has no readable response.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = generationResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new BundleError("bundle response.json does not satisfy the generation protocol");
  }
  const byRole = new Map(parsed.data.artifacts.map((artifact) => [artifact.role, artifact.path]));
  const missing = REQUIRED_ROLES.filter((role) => !byRole.has(role));
  if (missing.length > 0) {
    throw new BundleError(`bundle is missing artifact roles: ${missing.join(", ")}`);
  }
  const resolveRole = (role: ArtifactRole): string => {
    const declared = byRole.get(role) ?? "";
    if (declared.startsWith("/") || declared.split("/").includes("..")) {
      throw new BundleError(`artifact path for ${role} escapes the bundle`);
    }
    return join(bundlePath, declared);
  };

  const budget = { entries: 0, bytes: 0 };
  const statementPath = resolveRole("problem_statement");
  let statement: string;
  try {
    statement = await readFile(statementPath, "utf8");
  } catch {
    throw new BundleError("bundle problem statement is not a readable file");
  }
  const [template, solution, tests] = await Promise.all([
    readTree(resolveRole("template"), budget),
    readTree(resolveRole("solution"), budget),
    readTree(resolveRole("tests"), budget),
  ]);
  return {
    root: bundlePath,
    statement,
    statementPath: (byRole.get("problem_statement") ?? "").split(sep).join("/"),
    template,
    solution,
    tests,
  };
}

export function javaFiles(files: BundleFile[]): BundleFile[] {
  return files.filter((file) => file.path.endsWith(".java"));
}

export interface JavaAnalysis {
  units: JavaUnit[];
  /** Files that could not be lexed, with the reason; never silently dropped. */
  unparsed: Array<{ path: string; reason: string }>;
}

export function analyseJavaFiles(files: BundleFile[]): JavaAnalysis {
  const units: JavaUnit[] = [];
  const unparsed: Array<{ path: string; reason: string }> = [];
  for (const file of javaFiles(files)) {
    try {
      units.push(analyseJavaUnit(file.path, file.content));
    } catch (error) {
      unparsed.push({
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { units, unparsed };
}
