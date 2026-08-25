import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveContained } from "../../src/adapters/paths.ts";
import type { BundleFile } from "../shared/bundle.ts";
import { InfrastructureError } from "../shared/protocol.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
  TestCaseResult,
} from "./backend.ts";

const ASSIGNMENT_DIRECTORY = "assignment";
const TEST_REPORTS = join("build", "test-results", "test");
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const MAXIMUM_DIAGNOSTIC_LINES = 40;

export const gradleBackendConfigSchema = z
  .object({
    kind: z.literal("gradle"),
    /** Resolved through PATH unless it is a path. A pinned installation is preferred. */
    command: z.string().min(1).default("gradle"),
    arguments: z.array(z.string().min(1)).default(["--no-daemon", "clean", "test"]),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    /** Isolates dependency and daemon state from the operator's default Gradle home. */
    user_home: z.string().min(1).optional(),
    offline: z.boolean().default(false),
    java_home: z.string().min(1).optional(),
    work_directory: z.string().min(1).optional(),
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type GradleBackendConfig = z.infer<typeof gradleBackendConfigSchema>;

interface GradleRun {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function decodeXml(value: string | undefined): string | undefined {
  return value
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
}

function parseGradleReport(xml: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const opening = /<testcase\b([^>]*?)(\/?)>/g;
  let match = opening.exec(xml);
  while (match !== null) {
    const attributes = match[1] ?? "";
    const selfClosing = match[2] === "/";
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    let body = "";
    if (!selfClosing) {
      const closing = xml.indexOf("</testcase>", opening.lastIndex);
      body = xml.slice(opening.lastIndex, closing === -1 ? undefined : closing);
      if (closing !== -1) opening.lastIndex = closing + "</testcase>".length;
    }
    if (name !== undefined && !/<skipped\b/.test(body)) {
      const failure = /<(?:failure|error)\b([^>]*)>/.exec(body);
      const message =
        failure === null ? undefined : decodeXml(/\bmessage="([^"]*)"/.exec(failure[1] ?? "")?.[1]);
      cases.push({
        name: decodeXml(name) ?? name,
        passed: failure === null,
        ...(message === undefined || message === "" ? {} : { message }),
      });
    }
    match = opening.exec(xml);
  }
  return cases;
}

function diagnostics(run: GradleRun): string[] {
  const lines = run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /FAILURE:|BUILD FAILED|Compilation failed|error:/i.test(line))
    .slice(-MAXIMUM_DIAGNOSTIC_LINES)
    .map((line) => line.slice(0, 512));
  if (run.timedOut) lines.unshift("the Gradle build exceeded its configured timeout");
  return lines;
}

async function writeFiles(root: string, files: BundleFile[]): Promise<void> {
  for (const file of files) {
    const destination = resolveContained(root, file.path, "candidate file");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.rawContent ?? file.content);
  }
}

/** Runs Artemis-style Gradle tests, whose build declares `assignment/src` as its main source root. */
export class GradleBuildBackend implements BuildBackend {
  readonly id = "gradle";

  private resolvedToolchain: string | null | undefined;

  constructor(private readonly config: GradleBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-gradle-"));
    try {
      signal.throwIfAborted();
      const template = await this.buildSubmission(
        root,
        "template",
        job.bundle.tests,
        job.bundle.template,
        signal,
      );
      signal.throwIfAborted();
      const solution = await this.buildSubmission(
        root,
        "solution",
        job.bundle.tests,
        job.bundle.solution,
        signal,
      );
      return {
        template,
        solution,
        attestation: {
          backend_id: this.id,
          artemis_revision: null,
          build_agent_image: null,
          build_script_revision: null,
          toolchain: await this.toolchain(),
          unattested: ["artemis_revision", "build_agent_image", "build_script_revision"],
        },
      };
    } finally {
      if (!this.config.keep_build_trees) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  private environment(): { env?: Record<string, string | undefined> } {
    const overrides: Record<string, string | undefined> = {};
    if (this.config.java_home !== undefined) overrides.JAVA_HOME = this.config.java_home;
    if (this.config.user_home !== undefined) overrides.GRADLE_USER_HOME = this.config.user_home;
    return Object.keys(overrides).length === 0 ? {} : { env: { ...process.env, ...overrides } };
  }

  private async toolchain(): Promise<string | null> {
    if (this.resolvedToolchain !== undefined) return this.resolvedToolchain;
    try {
      const child = Bun.spawn([this.config.command, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        ...this.environment(),
      });
      const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      const gradle = /Gradle \S+/.exec(stdout)?.[0];
      const runtime = /JVM:\s+[^\n]+/.exec(stdout)?.[0];
      this.resolvedToolchain = [gradle, runtime].filter(Boolean).join("; ") || null;
    } catch {
      this.resolvedToolchain = null;
    }
    return this.resolvedToolchain;
  }

  private async buildSubmission(
    root: string,
    variant: "template" | "solution",
    tests: BundleFile[],
    submission: BundleFile[],
    signal: AbortSignal,
  ): Promise<SubmissionBuild> {
    const directory = join(root, variant);
    await mkdir(directory, { recursive: true });
    await writeFiles(directory, tests);
    await writeFiles(join(directory, ASSIGNMENT_DIRECTORY), submission);

    const run = await this.runGradle(directory, signal);
    const cases = await this.readReports(directory);
    const testsExecuted = cases !== null;
    return {
      compiled: testsExecuted || run.exitCode === 0,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage: null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private async runGradle(directory: string, signal: AbortSignal): Promise<GradleRun> {
    const argv = [this.config.command, ...this.config.arguments];
    if (this.config.offline) argv.push("--offline");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.config.build_timeout_ms);
    try {
      const child = Bun.spawn(argv, {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
        ...this.environment(),
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      signal.throwIfAborted();
      return {
        exitCode,
        timedOut: controller.signal.aborted,
        output: `${stdout}${stderr}`.slice(-MAXIMUM_DIAGNOSTIC_BYTES),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new InfrastructureError(
        `could not run ${this.config.command}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    const reports = join(directory, TEST_REPORTS);
    let entries: string[];
    try {
      entries = await readdir(reports);
    } catch {
      return null;
    }
    const xml = entries.filter((entry) => entry.endsWith(".xml"));
    if (xml.length === 0) return null;
    const cases: TestCaseResult[] = [];
    for (const entry of xml.sort()) {
      cases.push(...parseGradleReport(await readFile(join(reports, entry), "utf8")));
    }
    return cases;
  }
}
