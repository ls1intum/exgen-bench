import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { rejectSymlinkComponents, resolveContained } from "../../../src/adapters/paths.ts";
import { sha256 } from "../../../src/core/canonical.ts";
import type { EvaluationRequest } from "../../../src/evaluation/contracts.ts";
import type { BundleFile, CandidateBundle } from "../../kit/bundle.ts";
import { checkConsistency } from "../../tier1-deterministic/consistency/check.ts";
import { consistencyOutcome } from "../../tier1-deterministic/consistency/evaluate.ts";
import { flawsOutcome } from "../../tier1-deterministic/item-writing-flaws/evaluate.ts";
import { findFlaws } from "../../tier1-deterministic/item-writing-flaws/flaws.ts";
import { passRate } from "../../tier1-deterministic/java-oracle/backend.ts";
import { createBackend, loadWorkerConfig } from "../../tier1-deterministic/java-oracle/worker.ts";
import { exerciseSchema } from "../shared/exercise.ts";
import { blind, blindingLog, mutationAnalysis, type Replacement } from "./build.ts";
import { planConstraintChecks, runConstraintProbes } from "./constraints.ts";
import { automaticFindings } from "./findings.ts";
import { manifestSchema, readStudy } from "./study.ts";
import { testOverview } from "./tests.ts";

const archiveSchema = z.object({
  run_id: z.string(),
  published: z.array(
    z.object({
      case_id: z.string(),
      attempt_id: z.string(),
      files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    }),
  ),
});

/** Fingerprint the implementation and lockfile; a long build must not mix source revisions. */
async function implementationDigest(): Promise<string> {
  const root = resolve(import.meta.dir, "../../..");
  const files = ["package.json", "bun.lock"];
  for (const pattern of ["src/**/*.ts", "tools/**/*.ts"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root }))
      if (!path.includes("/node_modules/") && !path.includes("/dist/")) files.push(path);
  }
  const hashes = [];
  for (const path of files.sort())
    hashes.push(path + ":" + sha256(await readFile(join(root, path))));
  return sha256(hashes.join("\n"));
}

/** Re-measure a copied, frozen study from digest-checked original sources. No authored finding text. */
export async function refreshFindings(
  directory: string,
  archiveDirectory: string,
  options: { rebuild: boolean; report: string },
): Promise<void> {
  if (!options.rebuild)
    throw new Error("Use --rebuild only in a new study directory, before inviting raters.");
  const root = resolve(directory),
    archive = resolve(archiveDirectory);
  const study = await readStudy(root);
  const reportPath = resolve(options.report);
  if (reportPath === root || reportPath.startsWith(root + "/"))
    throw new Error("Keep the private build report outside the study directory");
  if (!study.build) throw new Error("study.yaml needs a build.oracle configuration");
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, "exercises/manifest.json"), "utf8")),
  );
  const published = archiveSchema.parse(
    JSON.parse(await readFile(join(archive, "MANIFEST.json"), "utf8")),
  );
  const loaded = await loadWorkerConfig(resolve(root, study.build.oracle));
  const backend = createBackend(loaded.config, loaded.directory, process.env);
  if (backend.id !== "gradle")
    throw new Error("Archive refresh currently requires the Gradle source-analysis backend");
  const implementation = await implementationDigest();
  const previousLog = await readFile(join(root, "exercises/BLINDING.md"), "utf8").catch(() => "");
  const retainedRows = previousLog
    .split("\n")
    .filter(
      (line) =>
        /^\| [A-Z][A-Z0-9]* \|/.test(line) &&
        !/^\s*(tests|findings)(?:\[|\.|$)/.test(line.split("|")[3]?.trim() ?? ""),
    );
  const redactions = new Map<string, Replacement[]>();
  const results = [];
  const updated: Array<{ path: string; text: string }> = [];
  for (const entry of manifest.exercises) {
    const file = join(root, "exercises", entry.id + ".json");
    const old = await readFile(file, "utf8");
    if (sha256(old) !== entry.sha256) throw new Error(`Frozen digest mismatch: ${entry.id}`);
    const exercise = exerciseSchema.parse(JSON.parse(old));
    const record = published.published.find((c) => c.case_id === entry.source.case_id);
    if (published.run_id !== entry.source.run_id || record?.attempt_id !== entry.source.attempt_id)
      throw new Error(`Archive candidate does not match ${entry.id}`);
    const source = resolveContained(archive, record.case_id, "case");
    const lanes: {
      template: BundleFile[];
      solution: BundleFile[];
      tests: BundleFile[];
    } = {
      template: [],
      solution: [],
      tests: [],
    };
    for (const [path, digest] of Object.entries(record.files)) {
      const full = resolveContained(source, path, "archive file");
      await rejectSymlinkComponents(source, full, "archive file");
      const rawContent = await readFile(full);
      if (sha256(rawContent) !== digest)
        throw new Error(`Archive digest mismatch: ${entry.id}/${path}`);
      const slash = path.indexOf("/");
      const lane = path.slice(0, slash);
      if (lane === "template" || lane === "solution" || lane === "tests")
        lanes[lane].push({
          path: path.slice(slash + 1),
          content: rawContent.toString("utf8"),
          rawContent,
          bytes: rawContent.length,
        });
    }
    const bundle: CandidateBundle = {
      root: source,
      statement: exercise.statement,
      statementPath: join(source, "problem-statement.md"),
      ...lanes,
    };
    const job = { request: {} as EvaluationRequest, bundle };
    const signal = AbortSignal.timeout(90 * 60_000);
    process.stderr.write(`${entry.code}: building original template and solution\n`);
    const outcome = await backend.build(job, signal);
    if (
      !outcome.template.compiled ||
      !outcome.solution.compiled ||
      !outcome.template.tests_executed ||
      !outcome.solution.tests_executed ||
      passRate(outcome.template).rate !== 0 ||
      passRate(outcome.solution).rate !== 1
    )
      throw new Error(`${entry.id}: original build gates failed`);
    const mutation = await mutationAnalysis(entry.code, backend, {
      job,
      solution: { files: bundle.solution, build: outcome.solution },
      diff: exercise.diff,
    });
    const required = study.build.constraints[entry.code] ?? [];
    const plan = planConstraintChecks(bundle.statement, bundle.solution, exercise.diff, required);
    const probes = plan.probes;
    const constraints = await runConstraintProbes(
      backend,
      job,
      probes,
      outcome.solution.test_cases.map((t) => t.name),
      signal,
    );
    const responses = [
      {
        evaluator: { id: "consistency" },
        scores: consistencyOutcome(checkConsistency(bundle)).scores,
      },
      {
        evaluator: { id: "item-writing-flaws" },
        scores: flawsOutcome(findFlaws(bundle)).scores,
      },
    ];
    const tasks = exercise.tests
      .filter((group) => group.task !== null)
      .map((group) => ({
        title: group.task!,
        tests: group.tests.map((test) => test.name),
      }));
    const patterns = study.build.blinding.map((pattern) => new RegExp(pattern, "g"));
    const replacements: Replacement[] = [];
    exercise.tests = blind(
      { tests: testOverview(tasks, outcome.template.test_cases, mutation) },
      patterns,
      replacements,
    ).tests;
    exercise.facts.tests = exercise.tests.reduce((count, group) => count + group.tests.length, 0);
    exercise.findings = automaticFindings(responses, exercise.tests, mutation, {
      build: outcome.solution,
      solution: bundle.solution,
      diff: exercise.diff,
      constraints,
      unsupportedConstraints: plan.unsupported,
    });
    exercise.findings = blind({ findings: exercise.findings }, patterns, replacements).findings;
    redactions.set(entry.code, replacements);
    const text = JSON.stringify(exercise, null, 2) + "\n";
    exerciseSchema.parse(JSON.parse(text));
    updated.push({ path: file, text });
    entry.sha256 = sha256(text);
    results.push({
      code: entry.code,
      id: entry.id,
      source: entry.source,
      sourceFilesVerified: Object.keys(record.files).length,
      build: outcome,
      mutation: mutation
        ? {
            ran: mutation.ran,
            caught: mutation.caught,
            survivors: mutation.survivors,
            selected: mutation.selected,
            discarded: mutation.discarded,
            unresolved: mutation.unresolved,
          }
        : null,
      requirements: plan,
      constraints,
      findings: exercise.findings,
    });
    process.stderr.write(`${entry.code}: ${exercise.findings.items.length} finding groups\n`);
  }
  // No frozen file changes until every candidate passed verification and measurement.
  if ((await implementationDigest()) !== implementation)
    throw new Error(
      "The evaluator implementation changed during this build; rerun before freezing findings",
    );
  manifest.study_id = study.id;
  const freshLog = blindingLog(study.build.blinding, manifest, redactions);
  const freshRows = freshLog.split("\n").filter((line) => /^\| [A-Z][A-Z0-9]* \|/.test(line));
  const allRows = [...retainedRows, ...freshRows];
  for (const entry of manifest.exercises)
    entry.blinding_replacements = allRows.filter((row) =>
      row.startsWith(`| ${entry.code} |`),
    ).length;
  const finalBlindingLog =
    `# Blinding log\n\nStudy \`${study.id}\`. Original material redactions are retained; test feedback and findings are rechecked.\n\n` +
    (allRows.length
      ? "| Code | ID | Location | Line | Match | Original context |\n| --- | --- | --- | --- | --- | --- |\n" +
        allRows.join("\n") +
        "\n"
      : "No pattern matched.\n");

  const report = resolve(options.report);
  await mkdir(join(report, ".."), { recursive: true });
  await writeFile(
    report,
    JSON.stringify(
      {
        study: study.id,
        createdAt: new Date().toISOString(),
        implementationDigest: implementation,
        backendProfile: loaded.config.backend,
        results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  for (const file of updated) await writeFile(file.path, file.text);
  await writeFile(join(root, "exercises/BLINDING.md"), finalBlindingLog);
  await writeFile(join(root, "exercises/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
