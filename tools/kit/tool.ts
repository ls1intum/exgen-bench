import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  type ProcessEvaluationSummary,
  runProcessEvaluation,
} from "../../src/evaluation/process-run.ts";

/**
 * An evaluation tool is a directory under `tools/` with a `tool.yaml`: a named, tiered set of
 * process evaluators that can be run on its own. The manifest only selects and groups evaluator
 * configurations; what an evaluator measures stays pinned in its own `evaluator.yaml`.
 */

export const TOOLS_DIRECTORY = resolve(import.meta.dir, "..");
export const TOOL_MANIFEST = "tool.yaml";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "tool manifest paths must stay inside the tool directory",
  });

export const toolManifestSchema = z
  .strictObject({
    schema_version: z.literal("1"),
    id: identifier,
    tier: z.union([z.literal(1), z.literal(2)]),
    title: z.string().min(1),
    description: z.string().min(1),
    metric_cards: z.array(relativePath).default([]),
    evaluators: z
      .array(
        z.strictObject({
          id: identifier,
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

export type ToolManifest = z.infer<typeof toolManifestSchema>;

export interface LoadedTool {
  directory: string;
  manifest: ToolManifest;
  /** Absolute metric-card files: the shared kit cards first, then the tool's own. */
  metricCards: string[];
}

export const KIT_METRIC_CARDS = join(import.meta.dir, "metric-cards.json");

export async function loadTool(directory: string): Promise<LoadedTool> {
  const root = resolve(directory);
  const manifest = toolManifestSchema.parse(
    parse(await readFile(join(root, TOOL_MANIFEST), "utf8")),
  );
  return {
    directory: root,
    manifest,
    metricCards: [KIT_METRIC_CARDS, ...manifest.metric_cards.map((path) => join(root, path))],
  };
}

/** Every directory under `tools/` that carries a tool manifest, ordered by tier and then ID. */
export async function discoverTools(toolsDirectory = TOOLS_DIRECTORY): Promise<LoadedTool[]> {
  const tools: LoadedTool[] = [];
  for (const entry of await readdir(toolsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(toolsDirectory, entry.name);
    if (await Bun.file(join(directory, TOOL_MANIFEST)).exists()) {
      tools.push(await loadTool(directory));
    }
  }
  return tools.sort(
    (left, right) =>
      left.manifest.tier - right.manifest.tier || left.manifest.id.localeCompare(right.manifest.id),
  );
}

export interface ToolRunOptions {
  runDirectory: string;
  /** Evaluator IDs to run; the tool's default evaluators when empty. */
  evaluators?: string[];
  /** Replacement configuration paths by evaluator ID, e.g. a filled-in model endpoint. */
  configOverrides?: Map<string, string>;
  retryInfrastructure?: boolean;
  /** Called after each evaluator finishes, so a caller can report progress. */
  onEvaluated?: (summary: ToolEvaluationSummary) => void;
}

export interface ToolEvaluationSummary extends ProcessEvaluationSummary {
  tool: string;
  tier: 1 | 2;
  config: string;
}

export function selectEvaluators(
  tool: LoadedTool,
  requested: string[] = [],
): ToolManifest["evaluators"] {
  if (requested.length === 0) {
    return tool.manifest.evaluators.filter((evaluator) => evaluator.default);
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

/** Refuse before anything runs when a selected evaluator still has only its template config. */
export function assertConfigured(
  tool: LoadedTool,
  evaluators: ToolManifest["evaluators"],
  overrides: Map<string, string> | undefined,
): void {
  const unconfigured = evaluators.filter(
    (evaluator) => evaluator.template && !overrides?.has(evaluator.id),
  );
  if (unconfigured.length > 0) {
    throw new Error(
      unconfigured
        .map(
          (evaluator) =>
            `${tool.manifest.id}/${evaluator.id} ships a template configuration; copy ${evaluator.config}, fill it in, and pass --config ${evaluator.id}=<path>`,
        )
        .join("\n"),
    );
  }
}

/** A configuration override for an evaluator that will not run is almost always a typo. */
export function assertKnownOverrides(
  evaluators: ToolManifest["evaluators"],
  overrides: Map<string, string> | undefined,
): void {
  const selected = new Set(evaluators.map((evaluator) => evaluator.id));
  const unknown = [...(overrides?.keys() ?? [])].filter((id) => !selected.has(id));
  if (unknown.length > 0) {
    throw new Error(`--config names evaluators that are not selected: ${unknown.join(", ")}`);
  }
}

/**
 * Run a tool's evaluators one after another over one run. Each writes its own append-only journal,
 * exactly as `exgen evaluate process` would, so a tool run and a manual run are interchangeable and
 * resume each other.
 */
export async function runTool(
  tool: LoadedTool,
  options: ToolRunOptions,
): Promise<ToolEvaluationSummary[]> {
  const summaries: ToolEvaluationSummary[] = [];
  const selected = selectEvaluators(tool, options.evaluators);
  assertConfigured(tool, selected, options.configOverrides);
  assertKnownOverrides(selected, options.configOverrides);
  for (const evaluator of selected) {
    const config = resolve(
      options.configOverrides?.get(evaluator.id) ?? join(tool.directory, evaluator.config),
    );
    const summary: ToolEvaluationSummary = {
      tool: tool.manifest.id,
      tier: tool.manifest.tier,
      config,
      ...(await runProcessEvaluation({
        runDirectory: options.runDirectory,
        configPath: config,
        retryInfrastructure: options.retryInfrastructure ?? false,
      })),
    };
    options.onEvaluated?.(summary);
    summaries.push(summary);
  }
  return summaries;
}

export interface CombinationOptions extends Omit<ToolRunOptions, "evaluators"> {
  /** Tool IDs to combine; every Tier 1 tool when empty. */
  tools?: string[];
  toolsDirectory?: string;
}

export interface CombinationResult {
  tools: string[];
  evaluations: ToolEvaluationSummary[];
  metricCards: string[];
}

/**
 * Run several Tier 1 tools over the same run. Only Tier 1 tools combine: they measure the candidate
 * itself and are independent of each other, whereas a Tier 2 judgement is a separate instrument that
 * is run, versioned and reported on its own.
 */
export async function runTier1Combination(options: CombinationOptions): Promise<CombinationResult> {
  const available = await discoverTools(options.toolsDirectory);
  const tierOne = available.filter((tool) => tool.manifest.tier === 1);
  const selected =
    options.tools === undefined || options.tools.length === 0
      ? tierOne
      : options.tools.map((id) => {
          const tool = available.find((candidate) => candidate.manifest.id === id);
          if (tool === undefined) {
            const known = tierOne.map((candidate) => candidate.manifest.id).join(", ");
            throw new Error(`unknown tool ${id}; Tier 1 tools: ${known}`);
          }
          if (tool.manifest.tier !== 1) {
            throw new Error(
              `${id} is a Tier ${tool.manifest.tier} tool and cannot be combined; run it on its own`,
            );
          }
          return tool;
        });
  if (new Set(selected.map((tool) => tool.manifest.id)).size !== selected.length) {
    throw new Error("each tool may be named only once");
  }
  for (const tool of selected) {
    assertConfigured(tool, selectEvaluators(tool), options.configOverrides);
  }
  assertKnownOverrides(
    selected.flatMap((tool) => selectEvaluators(tool)),
    options.configOverrides,
  );
  const evaluations: ToolEvaluationSummary[] = [];
  for (const tool of selected) {
    const own = new Set(selectEvaluators(tool).map((evaluator) => evaluator.id));
    evaluations.push(
      ...(await runTool(tool, {
        runDirectory: options.runDirectory,
        configOverrides: new Map(
          [...(options.configOverrides ?? new Map<string, string>())].filter(([id]) => own.has(id)),
        ),
        ...(options.retryInfrastructure === undefined
          ? {}
          : { retryInfrastructure: options.retryInfrastructure }),
        ...(options.onEvaluated === undefined ? {} : { onEvaluated: options.onEvaluated }),
      })),
    );
  }
  return {
    tools: selected.map((tool) => tool.manifest.id),
    evaluations,
    metricCards: [...new Set(selected.flatMap((tool) => tool.metricCards))],
  };
}

/** The `exgen release create` arguments that publish what a tool run wrote. */
export function releaseArguments(
  evaluations: ToolEvaluationSummary[],
  metricCards: string[],
): string[] {
  return [
    ...metricCards.flatMap((path) => ["--metric-cards", path]),
    ...evaluations.flatMap((evaluation) => ["--journal", evaluation.journal]),
  ];
}
