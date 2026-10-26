import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

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

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomId(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = [...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

const catalogSchema = z.array(z.looseObject({ id: z.number().int(), testName: z.string().min(1) }));

async function readCatalog(path: string | undefined): Promise<TestCatalog> {
  if (path === undefined) {
    return new Map();
  }
  const entries = catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return new Map(entries.map((entry) => [entry.id, entry.testName]));
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
function textFiles(files: BundleFile[]): SourceFile[] {
  return files
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

/** Remove every match of the blinding patterns from every string raters will see. */
function blind<T>(value: T, patterns: RegExp[]): { value: T; replacements: number } {
  let replacements = 0;
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      return patterns.reduce(
        (text, pattern) =>
          text.replace(pattern, () => {
            replacements += 1;
            return "[removed]";
          }),
        node,
      );
    }
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, visit(inner)]));
    }
    return node;
  };
  return { value: visit(value) as T, replacements };
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
  replacements: number;
  diagrams: ManifestEntry["diagrams"];
}> {
  const { entry, candidate } = input;
  const bundle = await readCandidateBundle(candidate.bundle_path);
  const catalog = await readCatalog(
    entry.test_catalog === undefined ? undefined : resolve(context.directory, entry.test_catalog),
  );
  const tasks = readTasks(bundle.statement, catalog);
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
  const source = blind(bundle.statement, context.patterns);
  const statement = await raterStatement(source.value, context.render);
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
  const blinded = blind(
    {
      schema_version: "1" as const,
      phase: entry.phase,
      brief: input.brief,
      statement: statement.markdown,
      diagrams: statement.diagrams,
      facts: {
        gates_passed: gates.value === "Passed",
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
  );
  return {
    exercise: blinded.value,
    replacements: source.replacements + blinded.replacements,
    diagrams: statement.presentation,
  };
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
          blinding_replacements: result.replacements,
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
  return manifest;
}
