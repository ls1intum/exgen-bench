import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readTextBounded } from "../../src/core/files.ts";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { z } from "zod";
import type { BundleFile } from "../shared/bundle.ts";
import type {
  BuildBackend,
  BuildJob,
  BuildOutcome,
  SubmissionBuild,
  TestCaseResult,
} from "./backend.ts";
import { type HostBuildRun, inspectHostTool, runHostBuild, writeBuildFiles } from "./host-build.ts";
import { readJUnitReports } from "./junit-report.ts";

const ASSIGNMENT_DIRECTORY = "assignment";

const SUREFIRE_REPORTS = join("target", "surefire-reports");

const JACOCO_REPORT = join("target", "site", "jacoco", "jacoco.xml");

/**
 * Pinned so a coverage figure is attributable to a known instrumenter. Invoked as a goal rather than
 * written into the candidate's `pom.xml`, which is itself under evaluation: an evaluator that edits
 * what it measures cannot claim to have measured it.
 */
const JACOCO_GOAL_PREFIX = "org.jacoco:jacoco-maven-plugin:0.8.12";

const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;

/** Matches the JUnit report bound: both are candidate-influenced XML read off disk. */
const MAXIMUM_COVERAGE_REPORT_BYTES = 16 * 1024 * 1024;

const MAXIMUM_DIAGNOSTIC_LINES = 40;

/**
 * The highest Java release any POM in the bundle asks for, or null when none of them says.
 *
 * Read from the two places Maven actually takes it from - the project properties and the
 * maven-compiler-plugin's configuration - rather than by scanning the document, because `<target>`
 * and `<release>` are legal element names inside any plugin's configuration and inside comments.
 * A scan picks those up, and a release nobody asked for is worse than none: it either selects a JDK
 * the sources were not written for, or fails a candidate for declaring a toolchain that does not
 * exist.
 *
 * Profiles are skipped. Whether one is active depends on the environment at build time, so a release
 * declared there cannot be resolved by reading the file.
 *
 * The highest wins because a bundle compiles under the newest release any module requires, and
 * `--release` downgrades cleanly while too old a JDK does not.
 */
export function declaredJavaRelease(files: readonly BundleFile[]): number | null {
  let highest: number | null = null;
  for (const file of files) {
    if (!file.path.endsWith("pom.xml")) {
      continue;
    }
    for (const release of declaredReleases(file.content)) {
      if (highest === null || release > highest) {
        highest = release;
      }
    }
  }
  return highest;
}

function declaredReleases(pom: string): number[] {
  const document = new DOMParser({ onError: () => undefined }).parseFromString(pom, "text/xml");
  const project = document.documentElement;
  if (project === null) {
    return [];
  }
  const releases: number[] = [];
  const properties = child(project, "properties");
  if (properties !== null) {
    for (const name of ["maven.compiler.release", "maven.compiler.target", "java.version"]) {
      push(releases, text(child(properties, name)));
    }
  }
  for (const plugins of ["plugins", "pluginManagement"]) {
    const container =
      plugins === "plugins"
        ? child(child(project, "build"), "plugins")
        : child(child(child(project, "build"), "pluginManagement"), "plugins");
    for (const plugin of elements(container, "plugin")) {
      if (text(child(plugin, "artifactId")) !== "maven-compiler-plugin") {
        continue;
      }
      const configuration = child(plugin, "configuration");
      for (const name of ["release", "target", "source"]) {
        push(releases, text(child(configuration, name)));
      }
    }
  }
  return releases;
}

/**
 * Parses a declared release, ignoring anything that is not one.
 *
 * `1.8` is the historical spelling of 8 and still appears in real templates. A property reference
 * such as `${java.version}` resolves only during a build and is deliberately not guessed at.
 */
function push(releases: number[], value: string | null): void {
  if (value === null) {
    return;
  }
  const match = /^(?:1\.)?(\d+)$/.exec(value.trim());
  if (match === null) {
    return;
  }
  const release = Number(match[1]);
  // Java releases are small integers; anything outside this range is a version of something else.
  if (release >= 1 && release <= 99) {
    releases.push(release);
  }
}

function child(parent: Element | null, name: string): Element | null {
  return parent === null ? null : (elements(parent, name)[0] ?? null);
}

function elements(parent: Element | null, name: string): Element[] {
  if (parent === null) {
    return [];
  }
  const found: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).localName === name) {
      found.push(node as Element);
    }
  }
  return found;
}

function text(element: Element | null): string | null {
  return element === null ? null : (element.textContent ?? null);
}

export const mavenBackendConfigSchema = z
  .object({
    kind: z.literal("maven"),
    command: z.string().min(1).default("mvn"),
    arguments: z.array(z.string().min(1)).default(["--batch-mode", "test"]),
    /**
     * On by default: the suite is executed either way, so coverage costs only the instrumentation.
     * Turn it off when `arguments` do not run a Maven lifecycle, since the goals bracket them.
     */
    coverage: z.boolean().default(true),
    /**
     * JDK homes by the Java release they provide, e.g. `{"17": "/usr/lib/jvm/java-17-openjdk-amd64"}`.
     *
     * A corpus spans Java releases, so one ambient `JAVA_HOME` builds some artifact under a
     * toolchain it never asked for and the failure that follows reads as a defect in the artifact.
     * Declared rather than discovered from the host, so the choice enters the configuration digest
     * and every figure is attributable to a named JDK.
     */
    java_homes: z.record(z.string().regex(/^\d+$/), z.string().min(1)).default({}),
    build_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(15 * 60_000),
    local_repository: z.string().min(1).optional(),
    offline: z.boolean().default(false),
    java_home: z.string().min(1).optional(),
    work_directory: z.string().min(1).optional(),
    keep_build_trees: z.boolean().default(false),
  })
  .strict();

export type MavenBackendConfig = z.infer<typeof mavenBackendConfigSchema>;

function diagnostics(run: HostBuildRun): string[] {
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

export class MavenBuildBackend implements BuildBackend {
  readonly id = "maven";

  /** The JDK home the most recent build used, so the attested toolchain is the one that ran. */
  private buildJavaHome: string | undefined;

  private readonly resolvedToolchain = new Map<string, string | null>();

  constructor(private readonly config: MavenBackendConfig) {}

  async build(job: BuildJob, signal: AbortSignal): Promise<BuildOutcome> {
    const parent = this.config.work_directory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "exgen-oracle-"));
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
          build_phase_scripts: [],
          build_branch: null,
          // This backend runs the generated Maven project directly rather than through a deployment,
          // so nothing here is attested by Artemis. What ran is the recorded toolchain.
          unattested: [
            "artemis_revision",
            "build_agent_image",
            "build_script_revision",
            "build_phase_scripts",
            "build_branch",
          ],
        },
      };
    } finally {
      if (!this.config.keep_build_trees) {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  /**
   * The Maven and Java versions that ran the most recent build.
   *
   * Keyed by JDK home rather than memoised once: with a JDK chosen per artifact, a single cached
   * string would attribute every candidate's numbers to whichever toolchain built the first one.
   */
  private async toolchain(): Promise<string | null> {
    const home = this.buildJavaHome ?? this.config.java_home ?? "";
    const cached = this.resolvedToolchain.get(home);
    if (cached !== undefined) {
      return cached;
    }
    const stdout = await inspectHostTool(
      [this.config.command, "--batch-mode", "--version"],
      this.environment(this.buildJavaHome).env,
    );
    const maven = stdout === null ? undefined : /Apache Maven \S+/.exec(stdout)?.[0];
    const runtime = stdout === null ? undefined : /Java version: \S+?(?=,|\s|$)/.exec(stdout)?.[0];
    const resolved = stdout === null ? null : [maven, runtime].filter(Boolean).join("; ") || null;
    this.resolvedToolchain.set(home, resolved);
    return resolved;
  }

  private environment(javaHome?: string): { env?: Record<string, string | undefined> } {
    const home = javaHome ?? this.config.java_home;
    if (home === undefined) {
      return {};
    }
    // PATH as well as JAVA_HOME: Maven resolves `java` from PATH for forked test JVMs, so JAVA_HOME
    // alone compiles against one release and runs the tests on another.
    return {
      env: {
        ...process.env,
        JAVA_HOME: home,
        // Assembled from present entries only. An empty trailing element is the *current* directory,
        // which during a build is a tree of candidate-authored files.
        PATH: [join(home, "bin"), process.env.PATH].filter(Boolean).join(delimiter),
      },
    };
  }

  /**
   * The JDK to build this bundle with, chosen from the release the bundle declares.
   *
   * Throws rather than falling back on a declared release `java_homes` does not cover: building
   * release 25 sources on a 17 toolchain fails in a way that reads as a defect in the artifact, and
   * building 17 sources on 25 can pass while measuring something the exercise did not ask for. An
   * empty `java_homes` opts out of the mechanism and keeps the single configured `java_home`.
   */
  private resolveJavaHome(files: readonly BundleFile[]): string | undefined {
    const release = declaredJavaRelease(files);
    if (release === null) {
      return this.config.java_home;
    }
    const configured = this.config.java_homes[String(release)];
    if (configured !== undefined) {
      return configured;
    }
    if (Object.keys(this.config.java_homes).length === 0) {
      return this.config.java_home;
    }
    throw new Error(
      `no JDK configured for Java release ${release}; java_homes declares ` +
        `${Object.keys(this.config.java_homes).sort().join(", ")}`,
    );
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
    await writeBuildFiles(directory, tests);
    await writeBuildFiles(join(directory, ASSIGNMENT_DIRECTORY), submission);

    const javaHome = this.resolveJavaHome([...tests, ...submission]);
    this.buildJavaHome = javaHome;
    let run = await this.runMaven(directory, signal, javaHome, this.config.coverage);
    let cases = await this.readReports(directory);
    if (cases === null && run.exitCode !== 0 && this.config.coverage) {
      // Coverage is never an acceptance gate, so it must not be able to fail one. Maven resolves
      // every goal named on the command line before it runs a lifecycle phase, so an unresolvable
      // instrumenter aborts the session before the candidate is ever compiled - which would be
      // recorded as the candidate failing to build. Retrying without it separates the two.
      run = await this.runMaven(directory, signal, javaHome, false);
      cases = await this.readReports(directory);
    }
    // Maven reports a non-zero exit for a failing test as well as for a failing compile, so the exit
    // code alone cannot separate them. Surefire wrote a report only if the sources compiled and the
    // suite started, which is the distinction the gate needs.
    const testsExecuted = cases !== null;
    const compiled = testsExecuted || run.exitCode === 0;
    return {
      compiled,
      tests_executed: testsExecuted,
      test_cases: cases ?? [],
      coverage: testsExecuted ? await this.readCoverage(directory) : null,
      diagnostics: testsExecuted && run.exitCode === 0 ? [] : diagnostics(run),
    };
  }

  private runMaven(
    directory: string,
    signal: AbortSignal,
    javaHome: string | undefined,
    coverage: boolean,
  ): Promise<HostBuildRun> {
    const argv = [this.config.command];
    if (coverage) {
      // The agent has to be prepared before the tests run and the report written after them.
      argv.push(`${JACOCO_GOAL_PREFIX}:prepare-agent`);
    }
    argv.push(...this.config.arguments);
    if (coverage) {
      argv.push(`${JACOCO_GOAL_PREFIX}:report`);
    }
    if (this.config.offline) {
      argv.push("--offline");
    }
    if (this.config.local_repository !== undefined) {
      argv.push(`-Dmaven.repo.local=${this.config.local_repository}`);
    }
    const environment = this.environment(javaHome).env;
    return runHostBuild({
      argv,
      directory,
      ...(environment === undefined ? {} : { environment }),
      signal,
      timeoutMs: this.config.build_timeout_ms,
      maximumOutputBytes: MAXIMUM_DIAGNOSTIC_BYTES,
    });
  }

  private async readReports(directory: string): Promise<TestCaseResult[] | null> {
    return readJUnitReports(join(directory, SUREFIRE_REPORTS));
  }

  /**
   * Statement and branch coverage of the assignment sources, from JaCoCo's XML report, in which
   *
   * Null rather than zero when the report is absent or carries no counter of that kind: a suite that
   * never ran and a suite that covered nothing are different facts, and only the second is a
   * measurement.
   */
  private async readCoverage(
    directory: string,
  ): Promise<{ statement: number | null; branch: number | null } | null> {
    let report: string;
    try {
      report = await readTextBounded(join(directory, JACOCO_REPORT), MAXIMUM_COVERAGE_REPORT_BYTES);
    } catch {
      return null;
    }
    const document = new DOMParser({ onError: () => undefined }).parseFromString(
      report,
      "text/xml",
    );
    const root = document.documentElement;
    if (root === null) {
      return null;
    }
    // JaCoCo writes a counter after the children it summarises, so the report element's own counters
    // are the aggregate over every package. Reading them as direct children rather than searching the
    // document keeps a single class's counters from being mistaken for the total.
    const ratio = (kind: string): number | null => {
      const counter = elements(root, "counter").find(
        (candidate) => candidate.getAttribute("type") === kind,
      );
      if (counter === undefined) {
        return null;
      }
      const missed = Number(counter.getAttribute("missed"));
      const covered = Number(counter.getAttribute("covered"));
      const total = missed + covered;
      return Number.isFinite(total) && total > 0 ? covered / total : null;
    };
    // JaCoCo's LINE counter is what other Java tooling calls statement coverage; INSTRUCTION counts
    // bytecode and would not compare with any figure published elsewhere.
    const statement = ratio("LINE");
    const branch = ratio("BRANCH");
    return statement === null && branch === null ? null : { statement, branch };
  }
}
