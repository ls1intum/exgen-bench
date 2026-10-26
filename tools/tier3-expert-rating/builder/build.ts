import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { resolveContained } from "../../../src/adapters/paths.ts";
import { sha256 } from "../../../src/core/canonical.ts";
import type { EvaluationCandidate, EvaluationRequest } from "../../../src/evaluation/contracts.ts";
import { withRunEvaluationSource } from "../../../src/evaluation/process-run.ts";
import {
  loadEvaluationJournalForRelease,
  type RunEvaluationSource,
} from "../../../src/evaluation/source.ts";
import { type BundleFile, readCandidateBundle } from "../../kit/bundle.ts";
import { analyseJavaUnit, methodBodyTokens } from "../../kit/java/structure.ts";
import type { BuildBackend } from "../../tier1-deterministic/java-oracle/backend.ts";
import { createBackend, loadWorkerConfig } from "../../tier1-deterministic/java-oracle/worker.ts";
import {
  exercisePath,
  EXERCISES_DIRECTORY,
  type Manifest,
  MANIFEST_FILE,
  type ManifestEntry,
  manifestSchema,
  readStudy,
  type Study,
} from "../server/study.ts";
import { type Exercise, exerciseSchema } from "../shared/exercise.ts";
import { addedLines, type SourceFile, templateDiff } from "./diff.ts";
import { automaticFindings } from "./findings.ts";
import {
  type DiagramRenderer,
  plantumlRenderer,
  raterStatement,
  readTasks,
  type TestCatalog,
} from "./statement.ts";
import { testOverview } from "./tests.ts";

/**
 * Build a study's exercises from generated candidates: one JSON document per exercise holding only
 * what raters may see, plus a manifest that freezes each document by its digest. A built exercise
 * keeps its random ID, and rebuilding it to different content is refused unless asked for, because
 * raters may already have seen it.
 */

/** 32 unambiguous symbols, so five random bits pick one without bias. */
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomId(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = [...bytes].map((byte) => ID_ALPHABET[byte >> 3]).join("");
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

const responseSchema = z.looseObject({
  status: z.string(),
  extensions: z
    .looseObject({
      artemis: z.looseObject({ evidence_path: z.string().min(1).optional() }).optional(),
    })
    .optional(),
});

const artemisEvidenceSchema = z.looseObject({
  exact_version: z.looseObject({
    programmingData: z.looseObject({
      testCases: z.array(z.looseObject({ id: z.number().int(), testName: z.string().min(1) })),
    }),
  }),
});

export interface GenerationRecord {
  /** Whether the generating system reported success, which for Artemis means it saved the exercise. */
  succeeded: boolean;
  /**
   * The test cases of the Artemis exercise version the candidate was saved as, which the Artemis
   * adapter records next to the artifacts. Statements reference tests by these IDs as
   * `<testid>N</testid>`. A candidate from another system has no such evidence and no such references.
   */
  catalog: TestCatalog;
}

export async function generationRecord(bundlePath: string): Promise<GenerationRecord> {
  const response = responseSchema.parse(
    JSON.parse(await readFile(join(bundlePath, "response.json"), "utf8")),
  );
  const evidence = response.extensions?.artemis?.evidence_path;
  if (evidence === undefined) {
    return { succeeded: response.status === "succeeded", catalog: new Map() };
  }
  const { exact_version } = artemisEvidenceSchema.parse(
    JSON.parse(await readFile(resolveContained(bundlePath, evidence, "evidence"), "utf8")),
  );
  return {
    succeeded: response.status === "succeeded",
    catalog: new Map(
      exact_version.programmingData.testCases.map((testCase) => [testCase.id, testCase.testName]),
    ),
  };
}

type Entry = Study["exercises"][number];

function candidateOf(source: RunEvaluationSource, entry: Entry): EvaluationCandidate {
  const matches = source.candidates.filter((candidate) =>
    "attempt" in entry.source
      ? candidate.attempt_id === entry.source.attempt
      : candidate.case_id === entry.source.case &&
        (entry.source.system === undefined || candidate.system_id === entry.source.system),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${entry.code} matches ${matches.length} candidates in run ${source.runId}; name exactly one by attempt`,
    );
  }
  return matches[0] as EvaluationCandidate;
}

/** Files a student would open: text files only, which is everything in a source repository. */
/** A clone's repository metadata, which no student sees as part of the exercise. */
const GIT_METADATA = /(^|\/)\.git\//;

function textFiles(files: BundleFile[]): SourceFile[] {
  return files
    .filter((file) => !GIT_METADATA.test(file.path))
    .filter((file) => !(file.rawContent ?? new TextEncoder().encode(file.content)).includes(0))
    .map((file) => ({ path: file.path, content: file.content }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Methods and types the solution changes, as a size fact for the exercise header. */
function implementedMembers(
  template: SourceFile[],
  solution: SourceFile[],
): { methods: number; types: number } {
  const bodies = (files: SourceFile[]) => {
    const result = new Map<string, string>();
    for (const file of files.filter((candidate) => candidate.path.endsWith(".java"))) {
      const unit = analyseJavaUnit(file.path, file.content);
      for (const method of unit.methods) {
        const key = `${method.typeName ?? ""}.${method.name}/${method.parameterCount}`;
        result.set(
          key,
          methodBodyTokens(unit, method)
            .map((token) => token.value)
            .join(" "),
        );
      }
    }
    return result;
  };
  const before = bodies(template);
  const changed = [...bodies(solution)]
    .filter(([key, body]) => before.get(key) !== body)
    .map(([key]) => key);
  return { methods: changed.length, types: new Set(changed.map((key) => key.split(".")[0])).size };
}

function buildRequest(candidate: EvaluationCandidate): EvaluationRequest {
  return {
    protocol_version: "1",
    evaluation_id: sha256(`survey-test-overview:${candidate.attempt_id}`),
    candidate,
    evaluator: {
      id: "expert-rating-builder",
      version: "1",
      revision: "source-tree",
      target_profile: "artemis-java-maven",
      implementation_digest: "0".repeat(64),
    },
    suite: { id: "expert-rating", version: "1", digest: "0".repeat(64) },
    requested_metrics: [],
  };
}

/** One blinding replacement, logged for the study team to review before the exercises freeze. */
export interface Replacement {
  /** Where in the exercise: a field, or a file path followed by the field. */
  location: string;
  line: number;
  match: string;
  /** The whole line the match is on, before the replacement. */
  context: string;
}

/**
 * Remove every match of the blinding patterns from every string raters will see, and log each
 * replacement: a pattern can also match exercise content, which the log makes visible.
 */
function blind<T>(value: T, patterns: RegExp[], log: Replacement[]): T {
  const visit = (node: unknown, location: string): unknown => {
    if (typeof node === "string") {
      return patterns.reduce((text, pattern) => {
        for (const match of text.matchAll(pattern)) {
          const before = text.slice(0, match.index);
          const start = before.lastIndexOf("\n") + 1;
          const end = text.indexOf("\n", match.index);
          log.push({
            location,
            line: before.split("\n").length,
            match: match[0],
            context: text.slice(start, end === -1 ? undefined : end).trim(),
          });
        }
        return text.replace(pattern, "[removed]");
      }, node);
    }
    if (Array.isArray(node)) {
      return node.map((inner, index) =>
        visit(
          inner,
          inner !== null && typeof inner === "object" && "path" in inner
            ? `${location}/${String(inner.path)}`
            : `${location}[${index}]`,
        ),
      );
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, inner]) => [
          key,
          visit(inner, location === "" ? key : `${location}.${key}`),
        ]),
      );
    }
    return node;
  };
  return visit(value, "") as T;
}

interface ExerciseInput {
  entry: Entry;
  candidate: EvaluationCandidate;
  brief: string;
  responses: Awaited<ReturnType<typeof loadEvaluationJournalForRelease>>["latest"];
}

async function buildExercise(
  input: ExerciseInput,
  context: {
    directory: string;
    backend: BuildBackend;
    render: DiagramRenderer | undefined;
    patterns: RegExp[];
  },
): Promise<{
  exercise: Omit<Exercise, "id">;
  replacements: Replacement[];
  diagrams: ManifestEntry["diagrams"];
}> {
  const { entry, candidate } = input;
  const bundle = await readCandidateBundle(candidate.bundle_path);
  const generation = await generationRecord(candidate.bundle_path);
  if (!generation.succeeded) {
    throw new Error(`${entry.code}: its generation did not succeed, so it did not pass every gate`);
  }
  const tasks = readTasks(bundle.statement, generation.catalog);
  const outcome = await context.backend.build(
    { request: buildRequest(candidate), bundle },
    AbortSignal.timeout(30 * 60_000),
  );
  if (!outcome.template.tests_executed) {
    throw new Error(
      `${entry.code}: the template's tests did not run, so there is no test overview`,
    );
  }
  const tests = testOverview(tasks, outcome.template.test_cases);
  // Blind the statement before its diagrams are rendered: an SVG may split or encode their text.
  const replacements: Replacement[] = [];
  const source = blind({ statement: bundle.statement }, context.patterns, replacements);
  const statement = await raterStatement(source.statement, context.render);
  const template = textFiles(bundle.template);
  const solution = textFiles(bundle.solution);
  const diff = templateDiff(template, solution);
  const findings = automaticFindings(
    input.responses.filter((response) => response.candidate.attempt_id === candidate.attempt_id),
    tests,
  );
  const gates = findings.metrics.find((metric) => metric.label === "Build and gates");
  if (gates === undefined) {
    throw new Error(`${entry.code}: run the java-oracle evaluator over the run before building`);
  }
  // The study rates only exercises that compile, whose solution passes every test, and whose
  // template passes none: the gates the java-oracle evaluator checks.
  if (gates.value !== "Passed") {
    throw new Error(`${entry.code}: it does not pass the java-oracle gates`);
  }
  const exercise = blind(
    {
      schema_version: "1" as const,
      phase: entry.phase,
      brief: input.brief,
      statement: statement.markdown,
      diagrams: statement.diagrams,
      facts: {
        tests: tests.reduce((count, group) => count + group.tests.length, 0),
        tasks: tasks.length,
        ...implementedMembers(template, solution),
        lines: addedLines(diff),
      },
      template,
      diff,
      tests,
      findings,
    },
    context.patterns,
    replacements,
  );
  return { exercise, replacements, diagrams: statement.presentation };
}

export interface BuildOptions {
  /** Replace exercises whose content changed since they were built. */
  rebuild?: boolean;
}

export async function buildStudy(directory: string, options: BuildOptions = {}): Promise<Manifest> {
  const root = resolve(directory);
  const study = await readStudy(root);
  if (study.build === undefined) {
    throw new Error("study.yaml has no build section");
  }
  const build = study.build;
  const { config, directory: oracleDirectory } = await loadWorkerConfig(
    resolve(root, build.oracle),
  );
  const backend = createBackend(config, oracleDirectory, process.env, {
    allowFixtureBackend: build.allow_fixture_oracle,
  });
  const render =
    build.plantuml === undefined ? undefined : plantumlRenderer(resolve(root, build.plantuml));
  const patterns = build.blinding.map((pattern) => new RegExp(pattern, "giu"));

  const manifestPath = join(root, EXERCISES_DIRECTORY, MANIFEST_FILE);
  const previous = (await Bun.file(manifestPath).exists())
    ? manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
    : undefined;
  const taken = new Set(previous?.exercises.map((entry) => entry.id));
  const entries = [...study.exercises, study.calibration];
  const runs = [...new Set(entries.map((entry) => resolve(root, entry.source.run)))];
  const built: ManifestEntry[] = [];
  const replaced = new Map<string, Replacement[]>();
  await mkdir(join(root, EXERCISES_DIRECTORY), { recursive: true });

  for (const run of runs) {
    await withRunEvaluationSource(run, async (source) => {
      const journals = (await readdir(join(run, "evaluations")))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(run, "evaluations", name));
      const { latest } = await loadEvaluationJournalForRelease(journals);
      for (const entry of entries.filter(
        (candidate) => resolve(root, candidate.source.run) === run,
      )) {
        const candidate = candidateOf(source, entry);
        const brief = source.cases.find((item) => item.id === candidate.case_id)?.brief;
        if (brief === undefined) {
          throw new Error(
            `${entry.code}: run ${source.runId} has no brief for case ${candidate.case_id}`,
          );
        }
        const result = await buildExercise(
          { entry, candidate, brief, responses: latest },
          { directory: root, backend, render, patterns },
        );
        const frozen = previous?.exercises.find((existing) => existing.code === entry.code);
        const id = frozen?.id ?? randomId(taken);
        const text = `${JSON.stringify(exerciseSchema.parse({ id, ...result.exercise }), null, 2)}\n`;
        const digest = sha256(text);
        if (frozen !== undefined && frozen.sha256 !== digest && options.rebuild !== true) {
          throw new Error(
            `${entry.code} (${id}) was built before with different content; pass --rebuild if no rater has seen it`,
          );
        }
        await writeFile(exercisePath(root, id), text);
        replaced.set(entry.code, result.replacements);
        built.push({
          code: entry.code,
          id,
          phase: entry.phase,
          sha256: digest,
          source: {
            run_id: source.runId,
            attempt_id: candidate.attempt_id,
            case_id: candidate.case_id,
            system_id: candidate.system_id,
            artifact_digest: candidate.artifact_digest,
          },
          blinding_replacements: result.replacements.length,
          diagrams: result.diagrams,
        });
      }
    });
  }
  const order = entries.map((entry) => entry.code);
  const manifest = manifestSchema.parse({
    schema_version: "1",
    study_id: study.id,
    exercises: built.sort((left, right) => order.indexOf(left.code) - order.indexOf(right.code)),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(root, EXERCISES_DIRECTORY, BLINDING_LOG),
    blindingLog(build.blinding, manifest, replaced),
  );
  return manifest;
}

/** The blinding log the study design asks to archive: every replacement, with its line. */
export const BLINDING_LOG = "BLINDING.md";

function blindingLog(
  patterns: string[],
  manifest: Manifest,
  replaced: ReadonlyMap<string, Replacement[]>,
): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("`", "'");
  const rows = manifest.exercises.flatMap((entry) =>
    (replaced.get(entry.code) ?? []).map(
      (replacement) =>
        `| ${entry.code} | ${entry.id} | ${cell(replacement.location)} | ${replacement.line} | \`${cell(replacement.match)}\` | ${cell(replacement.context.slice(0, 160))} |`,
    ),
  );
  return `# Blinding log

Study \`${manifest.study_id}\`. Patterns: ${patterns.length === 0 ? "none" : patterns.map((pattern) => `\`${cell(pattern)}\``).join(", ")}.

Every match below was replaced by \`[removed]\` in what raters see. Review each one before the study
starts: a pattern that also matches ordinary exercise content changes the exercise.

${rows.length === 0 ? "No pattern matched.\n" : `| Code | ID | Location | Line | Match | Line before the replacement |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`}`;
}
