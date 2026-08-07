import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { unzipSync } from "fflate";
import type { GenerationResponse } from "../../src/contracts.ts";

export interface ArchiveLimits {
  maxBytes: number;
  maxFiles: number;
  maxRatio: number;
}

function safeRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Artemis returned an unsafe archive path: ${path}`);
  }
  return path;
}

interface CentralEntry {
  name: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

export function centralEntries(bytes: Uint8Array, limits: ArchiveLimits): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (view.getUint32(offset, true) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error("Artemis returned an invalid ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // Reject ZIP64 before fflate scans attacker-controlled extra fields.
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 instructor exports are not supported");
  }
  if (centralOffset + centralSize > eocd || count > limits.maxFiles + 100) {
    throw new Error("Artemis ZIP central directory exceeds max_archive_files");
  }

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let fileCount = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Artemis returned a malformed ZIP central directory");
    }
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length || (flags & 1) !== 0 || ![0, 8].includes(compression)) {
      throw new Error("Artemis ZIP uses an unsupported or encrypted entry");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    const directory = name.endsWith("/");
    const checked = safeRelativePath(directory ? name.slice(0, -1) : name);
    if (names.has(checked)) throw new Error(`Artemis ZIP contains a duplicate path: ${checked}`);
    names.add(checked);

    if (madeBy >> 8 === 3) {
      const kind = (externalAttributes >>> 16) & 0xf000;
      if (kind !== 0 && kind !== 0x8000 && !(directory && kind === 0x4000)) {
        throw new Error(`Artemis ZIP contains a link or special file: ${checked}`);
      }
    }
    if (!directory) {
      fileCount += 1;
      total += uncompressedSize;
      if (fileCount > limits.maxFiles) {
        throw new Error(`Artemis repository exports exceed max_archive_files (${limits.maxFiles})`);
      }
      if (total > limits.maxBytes) {
        throw new Error(
          `Artemis repository exports exceed max_artifact_bytes (${limits.maxBytes} bytes remaining)`,
        );
      }
      if (
        uncompressedSize > 0 &&
        (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxRatio)
      ) {
        throw new Error(
          `Artemis ZIP entry exceeds max_archive_ratio (${limits.maxRatio}): ${checked}`,
        );
      }
    }
    entries.push({
      name: directory ? `${checked}/` : checked,
      directory,
      compressedSize,
      uncompressedSize,
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize)
    throw new Error("Artemis ZIP central directory size is inconsistent");
  return entries;
}

async function writeAtomic(path: string, contents: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function extractArchive(
  root: string,
  bytes: Uint8Array,
  limits: ArchiveLimits,
): Promise<number> {
  const entries = centralEntries(bytes, limits);
  const files = unzipSync(bytes);
  const expected = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  let written = 0;
  for (const [path, contents] of Object.entries(files)) {
    if (path.endsWith("/")) continue;
    const safe = safeRelativePath(path);
    if (!expected.delete(safe))
      throw new Error(`ZIP extractor returned an undeclared path: ${safe}`);
    written += contents.byteLength;
    await writeAtomic(join(root, safe), contents);
  }
  if (expected.size > 0) throw new Error(`Artemis ZIP extraction omitted ${expected.size} files`);
  return written;
}

export async function materializeCandidate(
  outputDirectory: string,
  problemStatement: string,
  archives: Record<"template" | "solution" | "tests", Uint8Array>,
  limits: ArchiveLimits,
): Promise<GenerationResponse["artifacts"]> {
  const artifactsRoot = join(outputDirectory, "artifacts");
  let remaining = limits.maxBytes - Buffer.byteLength(problemStatement);
  if (remaining < 0)
    throw new Error(`Artemis candidate exceeds max_artifact_bytes (${limits.maxBytes} bytes)`);
  await writeAtomic(join(artifactsRoot, "problem-statement.md"), problemStatement);

  const artifacts: GenerationResponse["artifacts"] = [
    {
      role: "problem_statement",
      path: "artifacts/problem-statement.md",
      media_type: "text/markdown",
    },
  ];
  for (const role of ["template", "solution", "tests"] as const) {
    const written = await extractArchive(join(artifactsRoot, role), archives[role], {
      ...limits,
      maxBytes: remaining,
    });
    remaining -= written;
    artifacts.push({ role, path: `artifacts/${role}` });
  }
  return artifacts;
}

export interface RetainedFile {
  repo: "template" | "solution" | "tests";
  path: string;
  content: string;
}

/**
 * Artemis hands back screened text rather than an archive, so the ZIP defences above do not apply,
 * but the byte and file bounds do: it is attacker-influenced content over the same connection. The
 * whole payload is checked before the first write, so a breached bound leaves no half-written tree.
 */
export async function materializeRetainedCandidate(
  outputDirectory: string,
  candidate: { problemStatement?: string | undefined; files: readonly RetainedFile[] },
  limits: Pick<ArchiveLimits, "maxBytes" | "maxFiles">,
): Promise<{ artifacts: GenerationResponse["artifacts"]; fileCount: number }> {
  if (candidate.files.length > limits.maxFiles)
    throw new Error(`Artemis retained candidate exceeds max_archive_files (${limits.maxFiles})`);

  const statement = candidate.problemStatement ?? "";
  const seen = new Set<string>();
  const planned = candidate.files.map((file) => {
    const path = safeRelativePath(file.path);
    const key = `${file.repo}/${path}`;
    if (seen.has(key))
      throw new Error(`Artemis retained candidate contains a duplicate path: ${key}`);
    seen.add(key);
    return { repo: file.repo, path, content: file.content };
  });
  const total = planned.reduce(
    (bytes, file) => bytes + Buffer.byteLength(file.content),
    Buffer.byteLength(statement),
  );
  if (total > limits.maxBytes)
    throw new Error(
      `Artemis retained candidate exceeds max_artifact_bytes (${limits.maxBytes} bytes)`,
    );

  const artifactsRoot = join(outputDirectory, "artifacts");
  const artifacts: GenerationResponse["artifacts"] = [];
  let fileCount = 0;
  if (statement.length > 0) {
    await writeAtomic(join(artifactsRoot, "problem-statement.md"), statement);
    fileCount += 1;
    artifacts.push({
      role: "problem_statement",
      path: "artifacts/problem-statement.md",
      media_type: "text/markdown",
    });
  }
  const populated = new Set<RetainedFile["repo"]>();
  for (const file of planned) {
    await writeAtomic(join(artifactsRoot, file.repo, file.path), file.content);
    fileCount += 1;
    populated.add(file.repo);
  }
  // Only repositories that actually received a file: a declared artifact path has to exist on disk,
  // and a retained candidate routinely has nothing for one of the three.
  for (const role of ["template", "solution", "tests"] as const) {
    if (populated.has(role)) artifacts.push({ role, path: `artifacts/${role}` });
  }
  return { artifacts, fileCount };
}

export async function verifyExportedRepositoryCommits(
  outputDirectory: string,
  expected: Record<"template" | "solution" | "tests", string>,
): Promise<void> {
  for (const role of ["template", "solution", "tests"] as const) {
    const directory = join(outputDirectory, "artifacts", role);
    const child = Bun.spawn(
      [
        "git",
        "--no-optional-locks",
        "-c",
        `safe.directory=${directory}`,
        "-C",
        directory,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `could not resolve the exported ${role} repository HEAD commit (git exit ${exitCode}): ${stderr.trim() || "no diagnostic output"}`,
      );
    }
    const actual = stdout.trim();
    if (actual !== expected[role]) {
      throw new Error(
        `exported ${role} repository HEAD does not match the saved commit: expected ${expected[role]}, observed ${actual}`,
      );
    }
  }
}
