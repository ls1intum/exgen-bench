import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { GenerationResponse } from "../../src/contracts.ts";

export interface CandidateBundle {
  problem_statement?: string;
  template?: Record<string, string>;
  solution?: Record<string, string>;
  tests?: Record<string, string>;
}

function safeRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`Artemis returned an unsafe artifact path: ${path}`);
  }
  return path;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeTree(
  root: string,
  files: Record<string, string>,
  budget: { remaining: number },
): Promise<void> {
  const entries = Object.entries(files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [path, contents] of entries) {
    const size = Buffer.byteLength(contents);
    budget.remaining -= size;
    if (budget.remaining < 0) {
      throw new Error("Artemis artifact bundle exceeds max_artifact_bytes");
    }
    await writeAtomic(join(root, safeRelativePath(path)), contents);
  }
}

export async function materializeCandidate(
  outputDirectory: string,
  bundle: CandidateBundle,
  maxBytes: number,
): Promise<GenerationResponse["artifacts"]> {
  const artifactsRoot = join(outputDirectory, "artifacts");
  const budget = { remaining: maxBytes };
  const artifacts: GenerationResponse["artifacts"] = [];

  if (bundle.problem_statement !== undefined) {
    budget.remaining -= Buffer.byteLength(bundle.problem_statement);
    if (budget.remaining < 0) {
      throw new Error("Artemis artifact bundle exceeds max_artifact_bytes");
    }
    await writeAtomic(join(artifactsRoot, "problem-statement.md"), bundle.problem_statement);
    artifacts.push({
      role: "problem_statement",
      path: "artifacts/problem-statement.md",
      media_type: "text/markdown",
    });
  }
  for (const role of ["template", "solution", "tests"] as const) {
    const files = bundle[role];
    if (files === undefined) {
      continue;
    }
    await mkdir(join(artifactsRoot, role), { recursive: true });
    await writeTree(join(artifactsRoot, role), files, budget);
    artifacts.push({ role, path: `artifacts/${role}` });
  }
  return artifacts;
}

export function isCompleteCandidate(bundle: CandidateBundle): boolean {
  return (
    typeof bundle.problem_statement === "string" &&
    bundle.problem_statement.length > 0 &&
    bundle.template !== undefined &&
    Object.keys(bundle.template).length > 0 &&
    bundle.solution !== undefined &&
    Object.keys(bundle.solution).length > 0 &&
    bundle.tests !== undefined &&
    Object.keys(bundle.tests).length > 0
  );
}
