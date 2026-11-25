import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../src/core/canonical.ts";
import { rubricSha256 } from "../tools/tier2-judge/llm-judge/staged/prompt.ts";
import { loadInstrumentVersion } from "../tools/tier3-expert-rating/builder/study.ts";

/**
 * The instrument 7 analysis on a synthetic export: the real instruments/7.yaml and hand-made ratings
 * that cover a replacement, a superseded backup, an incomplete rating, a single rating, Cannot
 * assess, an additional rating, and a 5/3/1 tie break. It runs the pinned R container, so it needs
 * Docker: EXGEN_SURVEY_ANALYSIS=1 bun test tests/survey-analysis-v7.test.ts
 */
const analysisTest = process.env.EXGEN_SURVEY_ANALYSIS === "1" ? test : test.skip;
const TIMEOUT = 15 * 60_000;
const directories: string[] = [];
afterAll(() => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));

type Row = Record<string, unknown>;
const EXERCISES = Array.from({ length: 12 }, (_, index) => ({
  code: `E${index + 1}`,
  phase: ["early", "middle", "late"][Math.floor(index / 4)]!,
  id: `S${String(index).padStart(3, "0")}`,
  sha256: "a".repeat(64),
}));

function rating(rater: string, exercise: string, answers: Row, extra: Row = {}): Row {
  const phase = EXERCISES.find((entry) => entry.code === exercise)!.phase;
  return {
    rater_id: rater,
    role: rater.startsWith("B") ? "reserve" : "main",
    exercise_code: exercise,
    exercise_id: EXERCISES.find((entry) => entry.code === exercise)!.id,
    exercise_sha256: "a".repeat(64),
    phase,
    position: 1,
    part_d_step: "exercise-1-D",
    assignment: "planned",
    instrument_version: "7",
    findings_presentations: "evidence-v2",
    findings_presentation_at_submit: "evidence-v2",
    complete: true,
    seconds_A: 300,
    seconds_B: 420,
    seconds_C: 480,
    seconds_D: 240,
    SPEC: "clear",
    GOAL: "central",
    SUPPORT: "appropriate",
    FEEDBACK: "useful",
    RD1: 4,
    RD2: 4,
    FIND: "confirmed",
    FLAG: "no",
    ...answers,
    ...extra,
  };
}

/** Two planned ratings per exercise, varied per exercise; the cases below override some. */
function study(): Row[] {
  const rows: Row[] = [];
  for (const [index, { code }] of EXERCISES.entries()) {
    const first = `M${(index % 4) + 1}`,
      second = `M${(index % 4) + 5}`;
    rows.push(rating(first, code, {}), rating(second, code, {}));
  }
  const replace = (rater: string, exercise: string, answers: Row, extra: Row = {}) => {
    const index = rows.findIndex((row) => row.rater_id === rater && row.exercise_code === exercise);
    rows[index] = rating(rater, exercise, answers, extra);
  };
  // E1: 5 and 3, a tie breaker gives 1; three classes, no majority.
  replace("M1", "E1", { RD1: 5, RD2: 5, FIND: "no_effect" });
  replace(
    "M5",
    "E1",
    {
      RD1: 4,
      RD2: 3,
      RD2_text: "Fix the boundary test.",
      FIND: "changed",
      FLAG: "yes",
      FLAG_text: "F1 overstates what the tests check.",
      SPEC: "clarify",
    },
    { position: 2, part_d_step: "exercise-3-D" },
  );
  rows.push(rating("B3", "E1", { RD2: 1 }, { assignment: "tie_breaker" }));
  // E2: M6 stopped after Part B; backup B1 stands in.
  replace("M6", "E2", { RD1: undefined, RD2: undefined, FIND: undefined }, { complete: false });
  rows.push(
    rating(
      "B1",
      "E2",
      { RD1: 3, RD2: 2, FIND: "changed" },
      { assignment: "backup", replaces: "M6" },
    ),
  );
  // E3: backup B2 was assigned, but M7 finished too: B2 is not used.
  rows.push(rating("B2", "E3", { RD2: 1 }, { assignment: "backup", replaces: "M7" }));
  // E4: M8 never started; one planned rating.
  rows.splice(
    rows.findIndex((row) => row.rater_id === "M8" && row.exercise_code === "E4"),
    1,
  );
  // E5: Cannot assess readiness after the findings, which were unavailable.
  replace("M1", "E5", {
    RD2: "cannot_assess",
    FIND: "cannot_assess",
    FEEDBACK: "cannot_assess",
    FLAG: "cannot_assess",
  });
  // E6: an additional rating is not planned.
  rows.push(rating("B4", "E6", { RD2: 1 }, { assignment: "additional" }));
  // E7: both say no findings, an N/A that never counts as agreement on quality.
  replace("M3", "E7", { FIND: "na" });
  replace("M7", "E7", { FIND: "na" });
  replace("M8", "E8", { FIND: "not_reviewed" });
  return rows;
}

async function report(
  ratings: Row[],
  judge?: { exerciseHash: string; modifiedRows?: boolean; answerOnFailure?: boolean },
): Promise<{ text: string; table: (name: string) => Promise<string[][]> }> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-survey-v7-"));
  directories.push(directory);
  const instrument = await loadInstrumentVersion("7");
  const data = {
    study: {
      id: "v7-synthetic",
      title: "Synthetic V7 study",
      ratings_per_exercise: 2,
      exercises: EXERCISES,
    },
    instrument,
    tables: {
      raters: [{ rater_id: "M1", role: "main", consented_at: "2026-11-30T09:00:00Z" }],
      ratings,
      background: [],
      exit: [
        {
          rater_id: "M1",
          role: "main",
          submitted_at: "2026-11-30T10:20:00Z",
          RATEEASE: "very_easy",
          SURVEYFB: "Make the material tabs easier to spot.",
        },
        { rater_id: "M2", role: "main", submitted_at: "2026-11-30T10:20:00Z", MATERIAL: "some" },
        { rater_id: "M3", role: "main", submitted_at: "2026-11-30T10:20:00Z" },
      ],
      briefs: [],
      events: [
        {
          rater_id: "M5",
          step: "exercise-3-D",
          type: "view",
          target: "prior-decision:5",
          at: "2026-11-30T09:12:00Z",
        },
      ],
      changes: [],
    },
  };
  await writeFile(join(directory, "data.json"), JSON.stringify(data));
  const judgeDirectory = judge === undefined ? undefined : join(directory, "judge");
  if (judge !== undefined && judgeDirectory !== undefined) {
    await mkdir(judgeDirectory);
    const id = EXERCISES[0]!.id;
    const byPart = [
      ["A", { SPEC: "clear" }],
      ["B", { GOAL: "central", SUPPORT: "appropriate" }],
      ["C", { FEEDBACK: "useful", RD1: 4 }],
      ["D", { RD2: 5 }],
    ] as const;
    const rows = byPart.flatMap(([part, answers]) =>
      Object.entries(answers).map(([item_id, value]) => {
        const broken = part === "C";
        return JSON.stringify({
          rubric_version: "7",
          judge_version: "staged-judge-5",
          exercise_id: id,
          part,
          item_id,
          answer: broken && !judge.answerOnFailure ? null : { value },
          status: broken ? "invalid_output" : "answered",
        });
      }),
    );
    const rowsText = `${rows.join("\n")}\n`;
    await writeFile(
      join(judgeDirectory, "rows.jsonl"),
      judge.modifiedRows ? `${rowsText}\n` : rowsText,
    );
    await writeFile(
      join(judgeDirectory, "run.json"),
      JSON.stringify({
        rubric_version: "7",
        judge_version: "staged-judge-5",
        presentation: { findings: "evidence-v2", text: "staged-text-6" },
        rubric_sha256: rubricSha256(instrument),
        rows_sha256: sha256(rowsText),
        exercises: [{ id, archive_sha256: judge.exerciseHash }],
      }),
    );
  }
  const { surveyReport } = await import("../tools/tier3-expert-rating/analysis/report.ts");
  await surveyReport(join(directory, "data.json"), directory, { judgeDirectory });
  return {
    text: await readFile(join(directory, "REPORT.md"), "utf8"),
    table: async (name) => csv(await readFile(join(directory, "tables", `${name}.csv`), "utf8")),
  };
}

function csv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.trimEnd().split("\n")) {
    const cells: string[] = [];
    for (const match of line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)) {
      const cell = match[1]!;
      cells.push(cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell);
      if (match[3] === "") break;
    }
    rows.push(cells);
  }
  return rows;
}
const row = (table: string[][], ...keys: string[]) => {
  const header = table[0]!;
  const found = table.find((cells) => keys.every((key, index) => cells[index] === key));
  if (!found) throw new Error(`no row ${keys.join(", ")}`);
  return Object.fromEntries(header.map((name, index) => [name, found[index]]));
};

describe("instrument 7 analysis", () => {
  analysisTest(
    "keeps planned pairs, replacements and tie breakers apart and stays descriptive",
    async () => {
      const { text, table } = await report(study());
      expect(text).toContain("instrument version 7");
      expect(text).toContain(
        "Planned places: 24 (12 exercises × 2). Complete: 23, of them 1 by backups",
      );
      expect(text).toContain(
        "Not used: 1 started but incomplete planned ratings; 1 backup ratings whose main rater also finished; 1 additional ratings.",
      );
      expect(text).toContain("Exercises with both planned ratings: 11 of 12.");
      expect(text).not.toMatch(/Wilcoxon|AC1|alpha|Pooled|bootstrap/);

      const exercises = await table("sq1-readiness-exercises");
      expect(row(exercises, "E1")).toMatchObject({
        RD2: "5, 3",
        "RD2 at 3/4": "split",
        "Tie breaker RD2": "1",
        "Classes incl. tie breaker": "4–5 · 3 · 1–2",
        "Conservative RD2 (operational)": "3",
      });
      expect(row(exercises, "E2")).toMatchObject({ Ratings: "2", Backups: "1", RD2: "2, 4" });
      expect(row(exercises, "E3")).toMatchObject({ Ratings: "2", Backups: "0", RD2: "4, 4" });
      expect(row(exercises, "E4")).toMatchObject({ Ratings: "1", "RD2 at 3/4": "incomplete" });
      expect(row(exercises, "E5")).toMatchObject({
        RD2: "CA, 4",
        "RD2 at 3/4": "incomplete",
        "Conservative RD2 (operational)": "",
      });

      const distribution = await table("sq1-readiness-distribution");
      expect(row(distribution, "RD2", "all")).toMatchObject({
        Places: "24",
        Complete: "23",
        "Cannot assess": "1",
        Assessable: "22",
        "5": "1",
        "4": "19",
        "3": "1",
        "2": "1",
        "At most editorial (4–5)": "20",
        "Usable with local changes (3)": "1",
        "Major revision or replacement (1–2)": "1",
      });
      expect(row(distribution, "RD2", "early")).toMatchObject({ Places: "8", Complete: "7" });

      const coverage = await table("answers-coverage");
      expect(row(coverage, "FEEDBACK")).toMatchObject({
        "Missing ratings": "1",
        "Cannot assess": "1",
        "N/A": "0",
        Assessable: "22",
      });

      expect(row(coverage, "FIND")).toMatchObject({
        "Cannot assess": "1",
        "N/A": "2",
        "Not reviewed": "1",
        Assessable: "19",
      });

      expect(row(coverage, "FLAG")).toMatchObject({
        "Cannot assess": "1",
        Assessable: "22",
      });

      const agreement = await table("sq2-items");
      expect(row(agreement, "SPEC")).toMatchObject({
        Pairs: "11",
        "Same answer": "10 (91 %)",
        "Both assessable": "11",
      });
      expect(agreement.some((cells) => ["FIND", "FLAG"].includes(cells[0] ?? ""))).toBe(false);
      const combinations = await table("sq2-item-combinations");
      expect(row(combinations, "SPEC", "clear / clarify")).toMatchObject({ Exercises: "1" });

      const readiness = await table("sq2-readiness");
      expect(row(readiness, "RD2")).toMatchObject({
        Pairs: "11",
        "Both assessable": "10",
        "Same level": "8 (80 %)",
        "Within one level": "8 (80 %)",
        "Across 2/3": "1 (10 %)",
        "Across 3/4": "2 (20 %)",
        "Exercises both 4–5": "8",
        "Exercises split": "2",
        "Exercises both 1–3": "0",
        "Exercises incomplete": "2",
      });

      const transition = await table("sq3-readiness-transition");
      expect(row(transition, "4")).toMatchObject({ "4": "19", "3": "1", "Cannot assess": "1" });
      const find = await table("sq3-find");
      expect(row(find, "changed")).toMatchObject({ "RD2 lower": "2", Total: "2" });
      expect(row(find, "not_reviewed")).toMatchObject({ Total: "1" });
      const debrief = await table("survey-feedback");
      expect(row(debrief, "RATEEASE", "very_easy")).toMatchObject({ Count: "1" });
      expect(row(debrief, "MATERIAL", "some")).toMatchObject({ Count: "1" });
      expect(row(debrief, "RATEEASE", "blank")).toMatchObject({ Count: "2" });
      expect(row(debrief, "MATERIAL", "blank")).toMatchObject({ Count: "2" });
      expect(text).toContain("Optional comments received: 1.");
      expect(text).not.toContain("Make the material tabs easier to spot.");
      expect(row(await table("sq3-by-position"), "Later")).toMatchObject({ lower: "1" });
      expect(text).toContain(
        "Recorded openings of the earlier decision: 1 planned ratings. Of these, 1 submitted",
      );

      expect(row(find, "cannot_assess")).toMatchObject({ "Not comparable": "1" });
      expect(text).toContain("RD2 against RD1: 20 same, 2 lower, 0 higher, 1 not comparable");

      expect(text).toContain("Free texts for coding: 2 answers");
      expect(row(await table("time"), "Session")).toMatchObject({ Count: "1", Minutes: "80.0" });
    },
    TIMEOUT,
  );

  analysisTest(
    "reports an export without ratings",
    async () => {
      const { text, table } = await report([]);
      expect(text).toContain("Complete: 0");
      expect(row(await table("sq2-readiness"), "RD2")).toMatchObject({
        Pairs: "0",
        "Exercises incomplete": "12",
      });
    },
    TIMEOUT,
  );

  analysisTest(
    "refuses to pool versions, guess values, or choose between surplus ratings",
    async () => {
      const ratings = study();
      await expect(
        report([
          ...ratings,
          rating("M9", "E9", {}, { instrument_version: "6", assignment: "additional" }),
        ]),
      ).rejects.toThrow("Cannot pool instrument versions");
      await expect(
        report([...ratings.slice(1), rating("M1", "E1", { FIND: "yes" })]),
      ).rejects.toThrow("FIND holds values the instrument does not offer: yes");
      await expect(
        report([...ratings, rating("B9", "E8", {}, { assignment: "backup" })]),
      ).rejects.toThrow("More than two planned ratings for E8");
    },
    TIMEOUT,
  );
});

analysisTest(
  "compares a staged run on the same assessable pairs and rejects a different exercise file",
  async () => {
    const { text, table } = await report(study(), { exerciseHash: "a".repeat(64) });
    expect(text).toContain("Frozen exercise files matching this export: 1.");
    expect(row(await table("judge-readiness"), "RD2")).toMatchObject({
      Comparisons: "2",
      "Judge 4–5, reviewer 1–3": "1",
    });
    const agreements = await table("judge-agreement");
    expect(row(agreements, "RD2")).toMatchObject({
      Exercises: "1",
      "Human–human exact": "0 (0 %)",
      "Judge–human exact": "1 (50 %)",
    });
    expect(row(agreements, "FEEDBACK")).toMatchObject({
      Exercises: "0",
      "Judge no run": "11",
      "Judge failed": "1",
    });
    expect(agreements.some((cells) => ["FIND", "FLAG"].includes(cells[0] ?? ""))).toBe(false);
    expect(
      (await table("judge-by-exercise")).some((cells) => ["FIND", "FLAG"].includes(cells[1] ?? "")),
    ).toBe(false);
    await expect(report(study(), { exerciseHash: "z".repeat(64) })).rejects.toThrow(
      "The Judge did not use the frozen exercise file",
    );
    await expect(
      report(study(), { exerciseHash: "a".repeat(64), modifiedRows: true }),
    ).rejects.toThrow("The staged Judge item rows do not match run.json");
    await expect(
      report(study(), { exerciseHash: "a".repeat(64), answerOnFailure: true }),
    ).rejects.toThrow("The staged Judge has an answer for a call that did not answer");
  },
  TIMEOUT,
);
