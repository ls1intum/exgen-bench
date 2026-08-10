import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BundleFile } from "../shared/bundle.ts";
import { InfrastructureError } from "../shared/protocol.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
  TestCaseResult,
} from "./backend.ts";

/**
 * Builds the candidate the way the target platform does: the tests repository is the Maven project,
 * and the submission under test is checked out into `assignment/`, which is what the generated
 * `pom.xml` names as its source directory.
 */
const ASSIGNMENT_DIRECTORY = "assignment";

const SUREFIRE_REPORTS = join("target", "surefire-reports");

/** Enough of the build log to explain a failure, bounded so a runaway build cannot fill the journal. */
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;

const MAXIMUM_DIAGNOSTIC_LINES = 40;

export const mavenBackendConfigSchema = z
  .object({
    kind: z.literal("maven"),
    /** Resolved through PATH unless it is a path. */
    command: z.string().min(1).default("mvn"),
    /**
     * `test` alone: the acceptance gate is decided by compilation and the test results, so a build
     * that packages or installs would only add failure modes the gate does not read.
     */
    arguments: z.array(z.string().min(1)).default(["--batch-mode", "test"]),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    /**
     * A per-backend Maven repository keeps a benchmark run from depending on whatever the host
     * happens to have cached, at the cost of one cold resolve. Omitted means the host default.
     */
    local_repository: z.string().min(1).optional(),
    /** Fails the resolve instead of reaching the network. Requires a warm `local_repository`. */
    offline: z.boolean().default(false),
    /**
     * The JDK the build runs on. Omitted means whatever the host resolves, which is a fidelity risk:
     * the generated `pom.xml` targets a specific release and the test harness installs a security
     * manager, so a host JDK far from the target platform's can fail a candidate for reasons that
     * have nothing to do with it. Pin it to the JDK the target platform builds with.
     */
    java_home: z.string().min(1).optional(),
    /** Where build trees are created. Omitted means the system temporary directory. */
    work_directory: z.string().min(1).optional(),
    /** Keeps build trees after the run so a surprising verdict can be reproduced by hand. */
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type MavenBackendConfig = z.infer<typeof mavenBackendConfigSchema>;

interface MavenRun {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * One `<testcase>`, and whether it passed.
 *
 * A `<skipped>` case is dropped rather than counted as failed. It never ran, so it is evidence about
 * neither submission, and counting it would move both pass rates that the acceptance gate compares.
 */
function parseSurefireReport(xml: string): TestCaseResult[] {
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
      if (closing !== -1) {
        opening.lastIndex = closing + "</testcase>".length;
      }
    }
    if (name !== undefined && !/<skipped\b/.test(body)) {
      const failure = /<(?:failure|error)\b([^>]*)>/.exec(body);
      const message =
        failure === null ? undefined : decodeXml(/\bmessage="([^"]*)"/.exec(failure[1] ?? "")?.[1]);
      cases.push({
        name: decodeXml(name) ?? name,
        passed: failure === null,
        ...(message !== undefined && message !== "" ? { message } : {}),
      });
    }
    match = opening.exec(xml);
  }
  return cases;
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

/** The tail of the build log, which is where Maven reports what stopped it. */
function diagnostics(run: MavenRun): string[] {
  const lines = run.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) =>
      /\[ERROR\]|BUILD FAILURE|COMPILATION ERROR|Cannot find symbol|error:/i.test(line),
    );
  const selected = lines.slice(-MAXIMUM_DIAGNOSTIC_LINES);
  if (run.timedOut) {
    selected.unshift(
      `the build exceeded its timeout after ${MAXIMUM_DIAGNOSTIC_LINES} reported lines`,
    );
  }
  return selected.map((line) => line.slice(0, 512));
}

async function writeFiles(root: string, files: BundleFile[]): Promise<void> {
  for (const file of files) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
}

/**
 * Builds and runs a generated exercise with Maven, which is what the target platform's build agent
 * does. The two submissions are built in separate trees from the same tests, so neither can observe
 * the other's `target/`.
 */
export class MavenBuildBackend implements BuildBackend {
  readonly id = "maven";

  constructor(private readonly config: MavenBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-"));
    try {
      const template = await this.buildSubmission(
        root,
        "template",
        job.bundle.tests,
        job.bundle.template,
        signal,
      );
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
          // This backend runs the generated Maven project directly rather than through a deployment,
          // so nothing here is attested by Artemis. What ran is the host toolchain.
          unattested: ["artemis_revision", "build_agent_image", "build_script_revision"],
        },
      };
    } finally {
      if (!this.config.keep_build_trees) {
        await rm(root, { recursive: true, force: true });
      }
    }
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

    const run = await this.runMaven(directory, signal);
    const cases = await this.readReports(directory);
    // Maven reports a non-zero exit for a failing test as well as for a failing compile, so the exit
    // code alone cannot separate them. Surefire wrote a report only if the sources compiled and the
    // suite started, which is the distinction the gate needs.
    const testsExecuted = cases !== null;
    const compiled = testsExecuted || run.exitCode === 0;
    return {
      compiled,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage: null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private async runMaven(directory: string, signal: AbortSignal): Promise<MavenRun> {
    const argv = [this.config.command, ...this.config.arguments];
    if (this.config.offline) {
      argv.push("--offline");
    }
    if (this.config.local_repository !== undefined) {
      argv.push(`-Dmaven.repo.local=${this.config.local_repository}`);
    }
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
        ...(this.config.java_home === undefined
          ? {}
          : { env: { ...process.env, JAVA_HOME: this.config.java_home } }),
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}${stderr}`.slice(-MAXIMUM_DIAGNOSTIC_BYTES);
      return { exitCode, timedOut: controller.signal.aborted && !signal.aborted, output };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new InfrastructureError(
        `could not run ${this.config.command}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Null when the suite never started, which is not the same as a suite that ran and reported nothing. */
  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    const reports = join(directory, SUREFIRE_REPORTS);
    let entries: string[];
    try {
      entries = await readdir(reports);
    } catch {
      return null;
    }
    const xml = entries.filter((entry) => entry.endsWith(".xml"));
    if (xml.length === 0) {
      return null;
    }
    const cases: TestCaseResult[] = [];
    for (const entry of xml.sort()) {
      cases.push(...parseSurefireReport(await readFile(join(reports, entry), "utf8")));
    }
    return cases;
  }
}
