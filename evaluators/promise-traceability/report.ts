#!/usr/bin/env bun

import { loadEvaluationJournal } from "../../src/evaluation/source.ts";
import type { EvaluationResponse, EvaluationScore } from "../../src/evaluation/contracts.ts";
import { DETERMINISTIC_METRICS } from "./scores.ts";

const journalPath = process.argv[2];
if (journalPath === undefined) {
  process.stderr.write("usage: bun run report.ts <evaluation-journal.jsonl>\n");
  process.exit(2);
}

function present(score: EvaluationScore | undefined): string {
  if (score === undefined) {
    return "—";
  }
  if (score.status !== "ok") {
    return score.status === "not_applicable" ? "n/a" : score.status;
  }
  if (typeof score.value === "number" && score.denominator !== undefined) {
    return `${score.value.toFixed(2)} (${score.numerator}/${score.denominator})`;
  }
  return String(score.value);
}

const responses = (await loadEvaluationJournal(journalPath)).sort((left, right) =>
  left.candidate.case_id < right.candidate.case_id ? -1 : 1,
);
const columns = ["case", "system", ...DETERMINISTIC_METRICS];
const rows = responses.map((response: EvaluationResponse) => {
  const byId = new Map(response.scores.map((score) => [score.metric_id, score]));
  return [
    response.candidate.case_id,
    response.candidate.system_id,
    ...DETERMINISTIC_METRICS.map((metricId) => present(byId.get(metricId))),
  ];
});

process.stdout.write(`| ${columns.join(" | ")} |\n`);
process.stdout.write(`| ${columns.map(() => "---").join(" | ")} |\n`);
for (const row of rows) {
  process.stdout.write(`| ${row.join(" | ")} |\n`);
}

process.stdout.write("\n## Unexercised promises\n");
for (const response of responses) {
  const unwitnessed = response.scores.find(
    (score) => score.metric_id === "promise.unwitnessed_claims",
  );
  if (unwitnessed === undefined || unwitnessed.evidence.length === 0) {
    continue;
  }
  process.stdout.write(`\n### ${response.candidate.case_id} (${response.candidate.system_id})\n`);
  for (const line of unwitnessed.evidence) {
    process.stdout.write(`- ${line}\n`);
  }
}
