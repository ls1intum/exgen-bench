import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type PublicAttempt,
  type PublicRelease,
  publicAttemptSchema,
  publicCatalogSchema,
  publicReleaseSchema,
} from "./contracts.ts";

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000_6;
}

function assertContained(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`release path escapes site root: ${path}`);
  }
}

async function collectRegularFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const metadata = await lstat(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (metadata.isSymbolicLink()) {
      throw new Error(`published release contains a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectRegularFiles(root, path)));
    } else if (metadata.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`published release contains a non-regular file: ${relativePath}`);
    }
  }
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

export function validateReleaseData(release: PublicRelease, attemptRows: string[]): void {
  if (release.scope.systems !== release.systems.length) {
    throw new Error("scope.systems does not match the system array");
  }
  if (release.scope.cases !== release.cases.length) {
    throw new Error("scope.cases does not match the case array");
  }
  if (new Set(release.systems.map((system) => system.id)).size !== release.systems.length) {
    throw new Error("system IDs must be unique");
  }
  if (new Set(release.cases.map((caseItem) => caseItem.id)).size !== release.cases.length) {
    throw new Error("case IDs must be unique");
  }

  for (const system of release.systems) {
    if (system.planned === 0) {
      throw new Error(`${system.id}: a published system must have at least one planned attempt`);
    }
    const dispositionTotal =
      system.accepted +
      system.quality_failed +
      system.abstained +
      (system.generation_failed ?? 0) +
      (system.budget_exceeded ?? 0) +
      (system.budget_unverifiable ?? 0) +
      system.infrastructure_failed +
      (system.not_started ?? 0);
    if (dispositionTotal !== system.planned) {
      throw new Error(`${system.id}: dispositions do not reconcile to planned attempts`);
    }
    if (system.started + (system.not_started ?? 0) !== system.planned) {
      throw new Error(`${system.id}: started and not-started attempts do not reconcile`);
    }
    if (
      system.primary.numerator !== system.accepted ||
      system.primary.denominator !== system.planned ||
      !closeEnough(system.primary.estimate, system.accepted / system.planned)
    ) {
      throw new Error(`${system.id}: primary endpoint must be accepted / planned`);
    }
    if (!closeEnough(system.primary.planned_sensitivity, system.accepted / system.planned)) {
      throw new Error(`${system.id}: planned-attempt sensitivity is inconsistent`);
    }
    if (system.started === 0) {
      if (
        system.primary.started_sensitivity !== undefined &&
        system.primary.started_sensitivity !== null
      ) {
        throw new Error(`${system.id}: zero-started sensitivity must be not applicable`);
      }
    } else if (
      system.primary.started_sensitivity === undefined ||
      system.primary.started_sensitivity === null ||
      !closeEnough(system.primary.started_sensitivity, system.accepted / system.started)
    ) {
      throw new Error(`${system.id}: started-attempt sensitivity is inconsistent`);
    }
    if (
      system.primary.interval_low > system.primary.estimate ||
      system.primary.interval_high < system.primary.estimate ||
      !/cluster/i.test(system.primary.interval_method)
    ) {
      throw new Error(`${system.id}: interval must contain the estimate and preserve clustering`);
    }

    const caseTotals = release.cases.reduce(
      (totals, caseItem) => {
        const result = caseItem.systems[system.id];
        if (!result) throw new Error(`${caseItem.id}: missing result for ${system.id}`);
        totals.accepted += result.accepted;
        totals.denominator += result.denominator;
        totals.qualityFailed += result.quality_failed;
        totals.abstained += result.abstained;
        totals.infrastructureFailed += result.infrastructure_failed;
        totals.generationFailed += result.generation_failed ?? 0;
        totals.budgetExceeded += result.budget_exceeded ?? 0;
        totals.budgetUnverifiable += result.budget_unverifiable ?? 0;
        totals.notStarted += result.not_started ?? 0;
        if (
          result.accepted +
            result.quality_failed +
            result.abstained +
            (result.generation_failed ?? 0) +
            (result.budget_exceeded ?? 0) +
            (result.budget_unverifiable ?? 0) +
            result.infrastructure_failed +
            (result.not_started ?? 0) !==
          result.denominator
        ) {
          throw new Error(`${caseItem.id}/${system.id}: dispositions do not match denominator`);
        }
        return totals;
      },
      {
        accepted: 0,
        denominator: 0,
        qualityFailed: 0,
        abstained: 0,
        infrastructureFailed: 0,
        generationFailed: 0,
        budgetExceeded: 0,
        budgetUnverifiable: 0,
        notStarted: 0,
      },
    );
    if (
      caseTotals.accepted !== system.accepted ||
      caseTotals.denominator !== system.planned ||
      caseTotals.qualityFailed !== system.quality_failed ||
      caseTotals.abstained !== system.abstained ||
      caseTotals.infrastructureFailed !== system.infrastructure_failed ||
      caseTotals.generationFailed !== (system.generation_failed ?? 0) ||
      caseTotals.budgetExceeded !== (system.budget_exceeded ?? 0) ||
      caseTotals.budgetUnverifiable !== (system.budget_unverifiable ?? 0) ||
      caseTotals.notStarted !== (system.not_started ?? 0)
    ) {
      throw new Error(`${system.id}: case-level and release-level counts disagree`);
    }
  }

  if (release.primary_contrast !== null) {
    const contrastSystemA = release.systems.find(
      (system) => system.id === release.primary_contrast?.system_a,
    );
    const contrastSystemB = release.systems.find(
      (system) => system.id === release.primary_contrast?.system_b,
    );
    if (!contrastSystemA || !contrastSystemB) {
      throw new Error("primary contrast references an unknown system");
    }
    const expectedContrast =
      contrastSystemA.primary.numerator / contrastSystemA.primary.denominator -
      contrastSystemB.primary.numerator / contrastSystemB.primary.denominator;
    if (
      !closeEnough(release.primary_contrast.estimate, expectedContrast) ||
      release.primary_contrast.interval_low > release.primary_contrast.estimate ||
      release.primary_contrast.interval_high < release.primary_contrast.estimate ||
      !/cluster/i.test(release.primary_contrast.method)
    ) {
      throw new Error("primary contrast is inconsistent or ignores the case clustering");
    }
  }

  if (attemptRows.length !== release.scope.planned_attempts) {
    throw new Error(
      `attempt export has ${attemptRows.length} rows, expected ${release.scope.planned_attempts}`,
    );
  }
  const attempts = attemptRows.map((line) => {
    const value = publicAttemptSchema.parse(JSON.parse(line));
    if (
      typeof value.observation_id !== "string" ||
      typeof value.case_id !== "string" ||
      typeof value.system_id !== "string" ||
      ![
        "accepted",
        "quality_failed",
        "abstained",
        "generation_failed",
        "budget_exceeded",
        "budget_unverifiable",
        "infrastructure_failed",
        "not_started",
      ].includes(value.outcome ?? "")
    ) {
      throw new Error("attempt record is missing observation_id");
    }
    if (
      (value.outcome === "accepted" && value.strict_accepted !== true) ||
      ([
        "quality_failed",
        "abstained",
        "generation_failed",
        "budget_exceeded",
        "budget_unverifiable",
      ].includes(value.outcome ?? "") &&
        value.strict_accepted !== false) ||
      (["infrastructure_failed", "not_started"].includes(value.outcome ?? "") &&
        value.strict_accepted !== null)
    ) {
      throw new Error(`${value.observation_id}: strict acceptance disagrees with outcome`);
    }
    return value;
  });
  const observationIds = attempts.map((attempt) => attempt.observation_id);
  if (new Set(observationIds).size !== observationIds.length) {
    throw new Error("attempt observation IDs must be unique");
  }
  for (const attempt of attempts) {
    if (attempt.generation_completed !== (attempt.lifecycle === "completed")) {
      throw new Error(
        `${attempt.observation_id}: generation_completed disagrees with the lifecycle`,
      );
    }
    if ((attempt.outcome === "not_started") !== (attempt.lifecycle === "planned")) {
      throw new Error(
        `${attempt.observation_id}: not-started outcome disagrees with the lifecycle`,
      );
    }
  }

  const expectedExecutionCoverage = new Map<string, number>([
    ["planned", attempts.length],
    ["started", attempts.filter((attempt) => attempt.lifecycle !== "planned").length],
    ["completed", attempts.filter((attempt) => attempt.generation_completed).length],
  ]);
  const expectedFinalDispositions = new Map<string, number>([
    ["accepted", attempts.filter((attempt) => attempt.outcome === "accepted").length],
    ["quality_failed", attempts.filter((attempt) => attempt.outcome === "quality_failed").length],
    ["abstained", attempts.filter((attempt) => attempt.outcome === "abstained").length],
    [
      "generation_failed",
      attempts.filter((attempt) => attempt.outcome === "generation_failed").length,
    ],
    ["budget_exceeded", attempts.filter((attempt) => attempt.outcome === "budget_exceeded").length],
    [
      "budget_unverifiable",
      attempts.filter((attempt) => attempt.outcome === "budget_unverifiable").length,
    ],
    [
      "infrastructure_failed",
      attempts.filter((attempt) => attempt.outcome === "infrastructure_failed").length,
    ],
    ["not_started", attempts.filter((attempt) => attempt.outcome === "not_started").length],
  ]);
  const validateStages = (
    stages: Array<{ id: string; count: number }>,
    expected: Map<string, number>,
    label: string,
  ): void => {
    const identifiers = stages.map((stage) => stage.id);
    if (new Set(identifiers).size !== expected.size) {
      throw new Error(`${label} stages must be unique and complete`);
    }
    for (const stage of stages) {
      if (stage.count !== expected.get(stage.id)) {
        throw new Error(`${stage.id}: ${label} count disagrees with raw attempts`);
      }
    }
  };
  validateStages(release.execution_coverage, expectedExecutionCoverage, "execution coverage");
  validateStages(release.final_dispositions, expectedFinalDispositions, "final disposition");
  if (
    release.final_dispositions.reduce((total, stage) => total + stage.count, 0) !== attempts.length
  ) {
    throw new Error("final dispositions must reconcile to planned attempts");
  }

  for (const system of release.systems) {
    const systemAttempts = attempts.filter((attempt) => attempt.system_id === system.id);
    const count = (outcome: PublicAttempt["outcome"]): number =>
      systemAttempts.filter((attempt) => attempt.outcome === outcome).length;
    if (
      systemAttempts.length !== system.planned ||
      count("accepted") !== system.accepted ||
      count("quality_failed") !== system.quality_failed ||
      count("abstained") !== system.abstained ||
      count("generation_failed") !== (system.generation_failed ?? 0) ||
      count("budget_exceeded") !== (system.budget_exceeded ?? 0) ||
      count("budget_unverifiable") !== (system.budget_unverifiable ?? 0) ||
      count("infrastructure_failed") !== system.infrastructure_failed ||
      count("not_started") !== (system.not_started ?? 0)
    ) {
      throw new Error(`${system.id}: raw attempts do not reconcile to release counts`);
    }
    if (
      system.started !==
        systemAttempts.filter((attempt) => attempt.lifecycle !== "planned").length ||
      system.completed !== systemAttempts.filter((attempt) => attempt.generation_completed).length
    ) {
      throw new Error(`${system.id}: lifecycle counts do not reconcile to raw attempts`);
    }
    for (const caseItem of release.cases) {
      const result = caseItem.systems[system.id];
      const caseAttempts = systemAttempts.filter((attempt) => attempt.case_id === caseItem.id);
      if (
        !result ||
        caseAttempts.length !== result.denominator ||
        caseAttempts.filter((attempt) => attempt.outcome === "accepted").length !== result.accepted
      ) {
        throw new Error(`${caseItem.id}/${system.id}: raw attempts disagree with case summary`);
      }
    }
  }
}

export async function validateSite(siteRoot = import.meta.dir): Promise<PublicRelease[]> {
  const catalogPath = resolve(siteRoot, "data/catalog.json");
  const catalogValue: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  const catalog = publicCatalogSchema.parse(catalogValue);
  if (catalog.releases.some((release) => release.manifest.includes("latest.json"))) {
    throw new Error("catalog must address immutable releases, not latest.json");
  }

  const documents: PublicRelease[] = [];
  for (const entry of catalog.releases) {
    const manifestPath = resolve(dirname(catalogPath), entry.manifest);
    assertContained(siteRoot, manifestPath);
    const releaseValue: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const release = publicReleaseSchema.parse(releaseValue);
    if (release.release_id !== entry.id || release.status !== entry.status) {
      throw new Error(`${entry.id}: catalog metadata does not match release manifest`);
    }
    const releaseDirectory = dirname(manifestPath);
    const attemptsPath = resolve(releaseDirectory, "./attempts.jsonl");
    assertContained(releaseDirectory, attemptsPath);
    if (!(await lstat(attemptsPath)).isFile()) {
      throw new Error(`${entry.id}: attempts export is not a regular file`);
    }
    const attempts = (await readFile(attemptsPath, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    validateReleaseData(release, attempts);
    const csvLines = (await readFile(resolve(releaseDirectory, "./attempts.csv"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    if (csvLines.length !== attempts.length + 1) {
      throw new Error(`${entry.id}: CSV and JSONL attempt counts disagree`);
    }
    const csvIds = new Set(csvLines.slice(1).map((line) => line.split(",", 1)[0]));
    const jsonlIds = attempts.map(
      (line) => (JSON.parse(line) as { observation_id: string }).observation_id,
    );
    if (jsonlIds.some((id) => !csvIds.has(id))) {
      throw new Error(`${entry.id}: CSV and JSONL observation IDs disagree`);
    }

    for (const download of release.downloads) {
      const downloadPath = resolve(releaseDirectory, download.path);
      assertContained(releaseDirectory, downloadPath);
      const metadata = await lstat(downloadPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${entry.id}: download does not exist: ${download.path}`);
      }
    }

    const checksumPath = resolve(releaseDirectory, "checksums.txt");
    const checksumLines = (await readFile(checksumPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const checksummedPaths = new Set<string>();
    for (const line of checksumLines) {
      const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9._/-]+)$/.exec(line);
      if (!match) throw new Error(`${entry.id}: malformed checksum line`);
      const expected = match[1];
      const fileName = match[2];
      if (!expected || !fileName) throw new Error(`${entry.id}: incomplete checksum line`);
      const filePath = resolve(releaseDirectory, fileName);
      assertContained(releaseDirectory, filePath);
      if (checksummedPaths.has(fileName)) {
        throw new Error(`${entry.id}: duplicate checksum path: ${fileName}`);
      }
      checksummedPaths.add(fileName);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${entry.id}: checksummed path is not a regular file: ${fileName}`);
      }
      if ((await sha256(filePath)) !== expected) {
        throw new Error(`${entry.id}: checksum mismatch for ${fileName}`);
      }
    }
    for (const download of release.downloads) {
      if (download.id === "checksums") continue;
      const normalizedPath = download.path.replace(/^\.\//, "");
      if (!checksummedPaths.has(normalizedPath)) {
        throw new Error(`${entry.id}: downloadable file is not covered by public checksums`);
      }
    }
    const expectedFiles = new Set(["checksums.txt", ...checksummedPaths]);
    const actualFiles = await collectRegularFiles(releaseDirectory);
    const unexpected = actualFiles.filter((path) => !expectedFiles.has(path));
    const absent = [...expectedFiles].filter((path) => !actualFiles.includes(path));
    if (unexpected.length > 0 || absent.length > 0) {
      throw new Error(
        `${entry.id}: published release inventory mismatch; unexpected=[${unexpected.join(", ")}], absent=[${absent.join(", ")}]`,
      );
    }
    documents.push(release);
  }
  return documents;
}

if (import.meta.main) {
  const releases = await validateSite(process.argv[2] ?? import.meta.dir);
  process.stdout.write(`Validated ${releases.length} static release(s).\n`);
}
