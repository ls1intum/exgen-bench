import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import { evaluationIdentifierSchema } from "./contracts.ts";
import {
  type LoadedProcessEvaluatorConfig,
  loadProcessEvaluatorConfig,
  processEvaluatorConfigSchema,
} from "./process-config.ts";
import {
  evaluateWithProcess,
  type ProcessEvaluationSummary,
  withRunEvaluationSource,
} from "./process-run.ts";

/**
 * An evaluation tool is a directory under `tools/` with a `tool.yaml`: a named, tiered set of
 * process evaluators. The manifest only selects and groups evaluator configurations; what an
 * evaluator measures stays pinned in its own `evaluator.yaml`.
 */

export const TOOLS_DIRECTORY = resolve(import.meta.dir, "../../tools");
const KIT_METRIC_CARDS = join(TOOLS_DIRECTORY, "kit", "metric-cards.json");

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "tool manifest paths must stay inside the tool directory",
  });

const toolManifestSchema = z
  .strictObject({
    schema_version: z.literal("1"),
    id: evaluationIdentifierSchema,
    tier: z.literal([1, 2]),
    title: z.string().min(1),
    description: z.string().min(1),
    metric_cards: z.array(relativePath).default([]),
    evaluators: z
      .array(
        z.strictObject({
          id: evaluationIdentifierSchema,
          config: relativePath,
          default: z.boolean().default(true),
          /** The shipped configuration is a template (e.g. a model endpoint) and must be replaced. */
          template: z.boolean().default(false),
          description: z.string().min(1),
        }),
      )
      .min(1),
  })
  .superRefine((manifest, context) => {
    const ids = manifest.evaluators.map((evaluator) => evaluator.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["evaluators"],
        message: "evaluator entries must have unique IDs",
      });
    }
  });

type ToolManifest = z.infer<typeof toolManifestSchema>;
type ToolEvaluator = ToolManifest["evaluators"][number];

export interface Tool {
  directory: string;
  manifest: ToolManifest;
  /** Absolute metric-card files: the shared kit cards first, then the tool's own. */
  metricCards: string[];
}

/**
 * Every directory under `tools/` that carries a `tool.yaml`, ordered by tier and then ID. A tool's ID
 * is its directory name, and an evaluator ID names one entry across all tools, so `--config <id>=`
 * is never ambiguous.
 */
export async function discoverTools(toolsDirectory = TOOLS_DIRECTORY): Promise<Tool[]> {
  const tools: Tool[] = [];
  const owners = new Map<string, string>();
  const entries = await readdir(toolsDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const manifestPath = join(toolsDirectory, entry.name, "tool.yaml");
    if (!entry.isDirectory() || !(await Bun.file(manifestPath).exists())) {
      continue;
    }
    const directory = join(toolsDirectory, entry.name);
    const manifest = toolManifestSchema.parse(parse(await readFile(manifestPath, "utf8")));
    if (manifest.id !== entry.name) {
      throw new Error(`${manifestPath} declares id ${manifest.id}; it must be ${entry.name}`);
    }
    for (const evaluator of manifest.evaluators) {
      const owner = owners.get(evaluator.id);
      if (owner !== undefined) {
        throw new Error(`evaluator ${evaluator.id} is listed by both ${owner} and ${manifest.id}`);
      }
      owners.set(evaluator.id, manifest.id);
    }
    tools.push({
      directory,
      manifest,
      metricCards: [
        KIT_METRIC_CARDS,
        ...manifest.metric_cards.map((path) => join(directory, path)),
      ],
    });
  }
  return tools.sort(
    (left, right) =>
      left.manifest.tier - right.manifest.tier || left.manifest.id.localeCompare(right.manifest.id),
  );
}

/** What a tool run executes, resolved before anything starts; `runToolPlan` loads the configurations. */
export interface ToolPlan {
  tools: string[];
  /** `config` is what runs; it differs from `defaultConfig` when `--config` replaced it. */
  evaluations: Array<{ tool: Tool; evaluator: string; config: string; defaultConfig: string }>;
  metricCards: string[];
  /** Tier 1 tools an implicit combination left out because they need a `--config`. */
  skipped: string[];
}

function findTool(tools: Tool[], id: string): Tool {
  const tool = tools.find((candidate) => candidate.manifest.id === id);
  if (tool === undefined) {
    const known = tools.map((candidate) => candidate.manifest.id).join(", ");
    throw new Error(`unknown tool ${id}; known: ${known}`);
  }
  return tool;
}

function selectEvaluators(tool: Tool, requested: string[]): ToolEvaluator[] {
  if (requested.length === 0) {
    return tool.manifest.evaluators.filter((evaluator) => evaluator.default);
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error("each evaluator may be named only once");
  }
  return requested.map((id) => {
    const evaluator = tool.manifest.evaluators.find((candidate) => candidate.id === id);
    if (evaluator === undefined) {
      const known = tool.manifest.evaluators.map((candidate) => candidate.id).join(", ");
      throw new Error(`${tool.manifest.id} has no evaluator ${id}; known: ${known}`);
    }
    return evaluator;
  });
}

function unconfigured(evaluators: ToolEvaluator[], overrides: Map<string, string>) {
  return evaluators.filter((evaluator) => evaluator.template && !overrides.has(evaluator.id));
}

function buildPlan(
  selected: Array<{ tool: Tool; evaluators: ToolEvaluator[] }>,
  overrides: Map<string, string>,
  skipped: string[] = [],
): ToolPlan {
  const missing = selected.flatMap(({ tool, evaluators }) =>
    unconfigured(evaluators, overrides).map(
      (evaluator) =>
        `${tool.manifest.id}/${evaluator.id} ships a template configuration; copy ${relative(dirname(TOOLS_DIRECTORY), join(tool.directory, evaluator.config))}, fill it in, and pass --config ${evaluator.id}=<path>`,
    ),
  );
  if (missing.length > 0) {
    throw new Error(missing.join("\n"));
  }
  const evaluations = selected.flatMap(({ tool, evaluators }) =>
    evaluators.map((evaluator) => {
      const defaultConfig = join(tool.directory, evaluator.config);
      return {
        tool,
        evaluator: evaluator.id,
        config: resolve(overrides.get(evaluator.id) ?? defaultConfig),
        defaultConfig,
      };
    }),
  );
  // An override for an evaluator that will not run is almost always a typo.
  const unused = [...overrides.keys()].filter(
    (id) => !evaluations.some((evaluation) => evaluation.evaluator === id),
  );
  if (unused.length > 0) {
    throw new Error(`--config names evaluator entries that are not selected: ${unused.join(", ")}`);
  }
  return {
    tools: selected.map(({ tool }) => tool.manifest.id),
    evaluations,
    metricCards: [...new Set(selected.flatMap(({ tool }) => tool.metricCards))],
    skipped,
  };
}

/** One tool of any tier, with its default evaluators or the ones named. */
export async function planTool(
  id: string,
  evaluators: string[] = [],
  overrides = new Map<string, string>(),
): Promise<ToolPlan> {
  const tool = findTool(await discoverTools(), id);
  return buildPlan([{ tool, evaluators: selectEvaluators(tool, evaluators) }], overrides);
}

/**
 * Several Tier 1 tools over the same run, each with its default evaluators. Only Tier 1 tools
 * combine: they measure the candidate itself and are independent of each other, whereas a Tier 2
 * judgement is a separate instrument that is run, versioned and reported on its own. Without named
 * tools, a tool whose defaults need a template configuration is skipped, not refused.
 */
export async function planTier1(
  ids: string[] = [],
  overrides = new Map<string, string>(),
): Promise<ToolPlan> {
  if (new Set(ids).size !== ids.length) {
    throw new Error("each tool may be named only once");
  }
  const available = await discoverTools();
  const withDefaults = (tool: Tool) => ({ tool, evaluators: selectEvaluators(tool, []) });
  if (ids.length > 0) {
    const named = ids.map((id) => {
      const tool = findTool(available, id);
      if (tool.manifest.tier !== 1) {
        throw new Error(
          `${id} is a Tier ${tool.manifest.tier} tool and cannot be combined; run it on its own`,
        );
      }
      return withDefaults(tool);
    });
    return buildPlan(named, overrides);
  }
  const tierOne = available.filter((tool) => tool.manifest.tier === 1).map(withDefaults);
  const runnable = tierOne.filter(
    ({ evaluators }) => unconfigured(evaluators, overrides).length === 0,
  );
  const skipped = tierOne.filter((entry) => !runnable.includes(entry));
  return buildPlan(
    runnable,
    overrides,
    skipped.map(({ tool }) => tool.manifest.id),
  );
}

export interface ToolEvaluationSummary extends ProcessEvaluationSummary {
  tool: string;
  tier: 1 | 2;
  config: string;
}

/**
 * Load the configuration that runs. A replacement must configure the same evaluator as the one it
 * replaces, or its journal would be reported under the wrong tool and metric cards. The shipped
 * configuration is parsed, not loaded, because a template's credentials need not exist.
 */
async function loadReplacing(
  evaluation: ToolPlan["evaluations"][number],
): Promise<LoadedProcessEvaluatorConfig> {
  const loaded = await loadProcessEvaluatorConfig(evaluation.config);
  if (evaluation.config !== evaluation.defaultConfig) {
    const shipped = processEvaluatorConfigSchema.parse(
      parse(await readFile(evaluation.defaultConfig, "utf8")),
    );
    if (loaded.evaluator.id !== shipped.evaluator.id) {
      throw new Error(
        `--config configures evaluator ${loaded.evaluator.id}, not ${shipped.evaluator.id}`,
      );
    }
  }
  return loaded;
}

/**
 * Run a plan's evaluators one after another under one hold of the run's lock, so every journal of a
 * combination covers the same candidates. Every configuration is loaded first: a missing file or
 * credential stops the run before any evaluator starts. Each evaluator writes its own append-only
 * journal through `evaluateWithProcess`, exactly as `exgen evaluate process` would, so the two
 * resume each other.
 */
export async function runToolPlan(
  plan: ToolPlan,
  options: {
    runDirectory: string;
    retryInfrastructure: boolean;
    onEvaluated?: ((summary: ToolEvaluationSummary) => void) | undefined;
  },
): Promise<ToolEvaluationSummary[]> {
  const loaded = await Promise.all(
    plan.evaluations.map(async (evaluation) => {
      try {
        return { ...evaluation, loaded: await loadReplacing(evaluation) };
      } catch (error) {
        throw new Error(
          `${evaluation.tool.manifest.id}/${evaluation.evaluator}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  return withRunEvaluationSource(options.runDirectory, async (source) => {
    const summaries: ToolEvaluationSummary[] = [];
    for (const evaluation of loaded) {
      const summary: ToolEvaluationSummary = {
        tool: evaluation.tool.manifest.id,
        tier: evaluation.tool.manifest.tier,
        config: evaluation.config,
        ...(await evaluateWithProcess(source, evaluation.loaded, {
          retryInfrastructure: options.retryInfrastructure,
        })),
      };
      options.onEvaluated?.(summary);
      summaries.push(summary);
    }
    return summaries;
  });
}

/** The `exgen release create` arguments that publish what a tool run wrote. */
export function releaseArguments(
  metricCards: string[],
  evaluations: ToolEvaluationSummary[],
): string[] {
  return [
    ...metricCards.flatMap((path) => ["--metric-cards", path]),
    ...evaluations.flatMap((evaluation) => ["--journal", evaluation.journal]),
  ];
}
