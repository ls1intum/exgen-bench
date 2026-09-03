import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "../src/core/canonical.ts";
import { toCsv, toJsonLines } from "../src/export/serialize.ts";
import familyCards from "../evaluators/metric-cards.json" with { type: "json" };
import { assignApproachColors } from "../site/approach-colors.ts";
import {
  type PublicAttempt,
  type PublicRelease,
  type PublicScore,
  publicReleaseSchema,
} from "../site/contracts.ts";
import {
  ATTEMPT_COLUMNS,
  SCORE_COLUMNS,
  evaluatedObservations,
  summarizeScores,
} from "../site/scores.ts";

const releaseDirectory = resolve(import.meta.dirname, "../site/data/demo-v0.1");
const releasePath = resolve(releaseDirectory, "release.json");

const cases = [
  {
    id: "bounded-counter",
    title: "Bounded counter",
    brief:
      "Create a small counter abstraction with explicit lower and upper bounds, plus tests for boundary behavior.",
    tags: ["state", "boundaries", "introductory"],
  },
  {
    id: "library-catalog",
    title: "Library catalog",
    brief:
      "Design a catalog that stores books by identifier and supports deterministic search and removal behavior.",
    tags: ["collections", "validation", "intermediate"],
  },
  {
    id: "temperature-series",
    title: "Temperature series",
    brief:
      "Implement a time-ordered temperature series with summary statistics and clear empty-series semantics.",
    tags: ["statistics", "edge-cases", "intermediate"],
  },
  {
    id: "route-planner",
    title: "Route planner",
    brief:
      "Generate a graph-based route planner that chooses a shortest valid route and reports unreachable destinations.",
    tags: ["graphs", "algorithms", "advanced"],
  },
  {
    id: "reservation-ledger",
    title: "Reservation ledger",
    brief:
      "Create a reservation ledger with conflict detection, cancellation, and a stable chronological view.",
    tags: ["dates", "invariants", "intermediate"],
  },
  {
    id: "discount-policy",
    title: "Discount policy",
    brief:
      "Model composable discount rules with eligibility constraints and deterministic rounding.",
    tags: ["polymorphism", "money", "advanced"],
  },
] as const;

interface DemoSystem {
  id: string;
  model: string;
  provider: string;
  approach: "Direct" | "Plan + review";
  accepted: number;
  cost: number;
  latency: number;
  color: string;
}

const approachColors = assignApproachColors(["Direct", "Plan + review"]);

function approachColor(approach: DemoSystem["approach"]): string {
  const color = approachColors.get(approach);
  if (!color) throw new Error(`Missing visual identity for ${approach}`);
  return color;
}

const systems: DemoSystem[] = [
  {
    id: "claude-opus-direct",
    model: "Claude Opus 4.6",
    provider: "anthropic",
    approach: "Direct",
    accepted: 9,
    cost: 0.76,
    latency: 118,
    color: approachColor("Direct"),
  },
  {
    id: "claude-opus-reviewed",
    model: "Claude Opus 4.6",
    provider: "anthropic",
    approach: "Plan + review",
    accepted: 10,
    cost: 0.94,
    latency: 151,
    color: approachColor("Plan + review"),
  },
  {
    id: "claude-sonnet-direct",
    model: "Claude Sonnet 4.6",
    provider: "anthropic",
    approach: "Direct",
    accepted: 8,
    cost: 0.24,
    latency: 72,
    color: approachColor("Direct"),
  },
  {
    id: "claude-sonnet-reviewed",
    model: "Claude Sonnet 4.6",
    provider: "anthropic",
    approach: "Plan + review",
    accepted: 9,
    cost: 0.32,
    latency: 96,
    color: approachColor("Plan + review"),
  },
  {
    id: "gemini-flash-direct",
    model: "Gemini 3.5 Flash",
    provider: "google",
    approach: "Direct",
    accepted: 7,
    cost: 0.07,
    latency: 44,
    color: approachColor("Direct"),
  },
  {
    id: "gemini-flash-reviewed",
    model: "Gemini 3.5 Flash",
    provider: "google",
    approach: "Plan + review",
    accepted: 8,
    cost: 0.1,
    latency: 61,
    color: approachColor("Plan + review"),
  },
  {
    id: "deepseek-direct",
    model: "DeepSeek V3.2",
    provider: "deepseek",
    approach: "Direct",
    accepted: 6,
    cost: 0.045,
    latency: 38,
    color: approachColor("Direct"),
  },
  {
    id: "deepseek-reviewed",
    model: "DeepSeek V3.2",
    provider: "deepseek",
    approach: "Plan + review",
    accepted: 7,
    cost: 0.065,
    latency: 54,
    color: approachColor("Plan + review"),
  },
  {
    id: "mistral-direct",
    model: "Mistral Large 3",
    provider: "mistral",
    approach: "Direct",
    accepted: 6,
    cost: 0.09,
    latency: 49,
    color: approachColor("Direct"),
  },
  {
    id: "mistral-reviewed",
    model: "Mistral Large 3",
    provider: "mistral",
    approach: "Plan + review",
    accepted: 8,
    cost: 0.14,
    latency: 68,
    color: approachColor("Plan + review"),
  },
  {
    id: "qwen-direct",
    model: "Qwen3 Max",
    provider: "alibaba",
    approach: "Direct",
    accepted: 7,
    cost: 0.12,
    latency: 57,
    color: approachColor("Direct"),
  },
  {
    id: "qwen-reviewed",
    model: "Qwen3 Max",
    provider: "alibaba",
    approach: "Plan + review",
    accepted: 8,
    cost: 0.17,
    latency: 79,
    color: approachColor("Plan + review"),
  },
];

function acceptedByCase(total: number): number[] {
  const counts = Array<number>(cases.length).fill(1);
  let remaining = total - cases.length;
  for (let index = 0; remaining > 0; index += 1) {
    const caseIndex = index % counts.length;
    counts[caseIndex] = (counts[caseIndex] ?? 1) + 1;
    remaining -= 1;
  }
  return counts;
}

const attempts: PublicAttempt[] = systems.flatMap((system, systemIndex) => {
  const caseCounts = acceptedByCase(system.accepted);
  return cases.flatMap((caseItem, caseIndex) =>
    [1, 2].map((replicate) => {
      const accepted = replicate <= (caseCounts[caseIndex] ?? 0);
      const ordinal = (systemIndex * cases.length + caseIndex) * 2 + replicate;
      return {
        observation_id: `${system.id}-${caseItem.id}-${replicate}`,
        case_id: caseItem.id,
        system_id: system.id,
        replicate,
        lifecycle: "completed" as const,
        outcome: accepted ? ("accepted" as const) : ("quality_failed" as const),
        strict_accepted: accepted,
        evaluator_strict_accepted: accepted,
        candidate_produced: true,
        generation_completed: true,
        cost_usd: system.cost,
        generation_duration_seconds: system.latency,
        model_calls: 20 + ((ordinal * 11) % 40),
        total_tokens: 200_000 + ((ordinal * 73_913) % 1_500_000),
      };
    }),
  );
});

const evaluators = [
  { id: "demo-oracle", version: "0.1", revision: "illustrative", authoritative: true },
  { id: "demo-consistency", version: "0.1", revision: "illustrative", authoritative: false },
];

const scores: PublicScore[] = attempts.flatMap((attempt, index) => {
  const identity = {
    observation_id: attempt.observation_id,
    case_id: attempt.case_id,
    system_id: attempt.system_id,
    replicate: attempt.replicate,
    metric_version: "1",
    numerator: null,
    denominator: null,
  };
  const score = (
    evaluator_id: string,
    metric_id: string,
    value: PublicScore["value"],
  ): PublicScore => ({
    ...identity,
    evaluator_id,
    metric_id,
    score_status: value === null ? "not_applicable" : "ok",
    value,
  });
  const coverageMeasured = !(attempt.case_id === "route-planner" && attempt.replicate === 2);
  const consistent = (index * 5) % 3 !== 0;
  if (attempt.evaluator_strict_accepted === null || attempt.evaluator_strict_accepted === undefined)
    return [];
  return [
    score("demo-oracle", "oracle.satisfied", attempt.evaluator_strict_accepted),
    score(
      "demo-oracle",
      "coverage.statement",
      coverageMeasured ? Math.round(55 + ((index * 37) % 41)) / 100 : null,
    ),
    score("demo-oracle", "tests.count", 6 + ((index * 7) % 15)),
    score("demo-consistency", "consistency.satisfied", consistent),
    score("demo-consistency", "consistency.residual_count", consistent ? 0 : 1 + ((index * 3) % 6)),
  ];
});

const evaluatorCards = familyCards.metrics.filter((card) =>
  scores.some((score) => score.metric_id === card.id),
);
const evaluated = evaluatedObservations(scores);

const template = (await Bun.file(releasePath).json()) as PublicRelease;
const costMetric = {
  id: "generation-cost",
  version: "1",
  name: "Generation cost",
  tier: "secondary" as const,
  construct: "Provider cost assigned to one planned programming-exercise generation.",
  unit: "USD per planned attempt",
  value_type: "number" as const,
  valid_range: { minimum: 0, maximum: 1_000_000 },
  direction: "lower is better",
  population: "All planned attempts",
  denominator: "Planned attempts with a frozen pricing basis",
  status_mapping: "Every planned attempt retains its observed or zero pre-start cost",
  implementation: "illustrative-pricing-v0.1",
  evidence: "Per-attempt cost and dated pricing basis",
  validation: {
    status: "planned" as const,
    method: "Demonstration only; no provider invoice validation was performed",
    evidence: [],
  },
  limitations: "Synthetic costs do not represent provider prices or measured spend",
};

const release: PublicRelease = {
  ...template,
  title: "Programming exercise generation",
  summary: "Compare generation systems by exercise success rate, cost, and generation time.",
  scope: {
    target: "Illustrative Java programming exercises",
    dataset: "Synthetic exercise briefs v0.1",
    cases: cases.length,
    systems: systems.length,
    planned_attempts: attempts.length,
    budget: "Two planned generations per exercise brief and system",
  },
  systems: systems.map((system) => {
    const estimate = system.accepted / 12;
    return {
      id: system.id,
      name: `${system.model} · ${system.approach}`,
      description: "Illustrative generation system",
      factors: {
        approach: system.approach,
        model: system.model,
        provider: system.provider,
      },
      color: system.color,
      planned: 12,
      started: 12,
      completed: 12,
      generated_candidates: 12,
      evaluator_accepted: system.accepted,
      accepted: system.accepted,
      quality_failed: 12 - system.accepted,
      abstained: 0,
      infrastructure_failed: 0,
      decision_metrics: {
        cost: {
          estimate: system.cost,
          currency: "USD",
          statistic: "mean per planned attempt",
          denominator: 12,
          pricing_basis: "Illustrative fixed USD schedule dated 2026-07-30",
        },
        latency: {
          estimate: system.latency,
          unit: "seconds",
          statistic: "median among started attempts",
          denominator: 12,
        },
      },
      primary: {
        estimate,
        numerator: system.accepted,
        denominator: 12,
        interval_low: Math.max(0, estimate - 0.2),
        interval_high: Math.min(1, estimate + 0.2),
        interval_method: "illustrative case-cluster 95% interval",
        planned_sensitivity: estimate,
        started_sensitivity: estimate,
      },
    };
  }),
  primary_contrast: {
    system_a: "claude-opus-reviewed",
    system_b: "claude-opus-direct",
    estimate: 1 / 12,
    interval_low: -1 / 12,
    interval_high: 0.25,
    unit: "proportion risk difference",
    method: "Illustrative case-cluster bootstrap 95% interval",
    note: "Synthetic paired contrast included only to exercise the release contract.",
  },
  cases: cases.map((caseItem, caseIndex) => ({
    ...caseItem,
    tags: [...caseItem.tags],
    systems: Object.fromEntries(
      systems.map((system) => {
        const accepted = acceptedByCase(system.accepted)[caseIndex] ?? 0;
        return [
          system.id,
          {
            accepted,
            denominator: 2,
            quality_failed: 2 - accepted,
            abstained: 0,
            infrastructure_failed: 0,
          },
        ];
      }),
    ),
  })),
  metrics: [
    ...template.metrics
      .filter(
        (metric) =>
          metric.id !== costMetric.id && !evaluatorCards.some((card) => card.id === metric.id),
      )
      .map((metric) =>
        metric.id === "strict-acceptance"
          ? {
              ...metric,
              name: "Exercise success rate",
              construct:
                "Percentage of planned attempts that produce a complete exercise, pass the independent evaluator, and stay within budget.",
            }
          : metric,
      ),
    costMetric,
    ...(evaluatorCards as PublicRelease["metrics"]),
  ],
  evaluations: {
    evaluators: evaluators.map((evaluator) => ({
      ...evaluator,
      evaluated: evaluated.get(evaluator.id) ?? 0,
    })),
    metrics: summarizeScores(scores),
  },
  limitations: [
    "All model names, outcomes, costs, durations, estimates, and intervals are synthetic.",
    "Six exercise briefs are too few for stable system-level conclusions.",
    "The demo contains no generated exercise artifacts and supports no empirical model claim.",
  ],
  provenance: {
    ...template.provenance,
    release_version: "0.1.0",
    dataset: "synthetic-briefs-v0.1",
    analysis: "precomputed-demo-aggregates-v0.2",
    pricing: "illustrative fixed USD schedule dated 2026-07-30",
    reproduction: "Run bun run demo:generate; the browser only renders checksummed estimates",
  },
  downloads: [
    ...template.downloads
      .filter((download) => !download.id.startsWith("scores_"))
      .map((download) =>
        download.id === "attempts_csv"
          ? { ...download, description: `CSV · ${attempts.length} synthetic rows` }
          : download,
      ),
    {
      id: "scores_csv",
      label: "Score table",
      description: `CSV · ${scores.length} synthetic metric observations`,
      path: "./scores.csv",
    },
    {
      id: "scores_jsonl",
      label: "Score records",
      description: "JSONL · one row per attempt, evaluator, and metric",
      path: "./scores.jsonl",
    },
  ],
};

const files: Record<string, string> = {
  "release.json": `${canonicalJson(publicReleaseSchema.parse(release))}\n`,
  "attempts.jsonl": toJsonLines(attempts),
  "attempts.csv": toCsv([...ATTEMPT_COLUMNS], attempts),
  "scores.jsonl": toJsonLines(scores),
  "scores.csv": toCsv([...SCORE_COLUMNS], scores),
};
for (const [name, content] of Object.entries(files)) {
  await writeFile(resolve(releaseDirectory, name), content);
}
const checksums = Object.entries(files)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, content]) => `${sha256(content)}  ${path}`)
  .join("\n");
await writeFile(resolve(releaseDirectory, "checksums.txt"), `${checksums}\n`);

process.stdout.write(
  `Generated ${attempts.length} illustrative attempt rows and ${scores.length} score rows.\n`,
);
