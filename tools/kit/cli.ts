import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { MEASURED_NOTHING_MESSAGE } from "../../src/evaluation/process-run.ts";
import {
  type LoadedTool,
  loadTool,
  releaseArguments,
  runTool,
  type ToolEvaluationSummary,
} from "./tool.ts";

function configOverride(value: string, previous: Map<string, string>): Map<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new InvalidArgumentError("expected <evaluator-id>=<config-path>");
  }
  return new Map(previous).set(value.slice(0, separator), value.slice(separator + 1));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function describeEvaluation(summary: ToolEvaluationSummary): string {
  return (
    `${summary.tool}/${summary.evaluator.id}: ${summary.executed} evaluated, ${summary.resumed} resumed · ` +
    `${summary.evaluator_strict_successes} acceptances · ${summary.quality_failures} quality failures · ` +
    `${summary.infrastructure_failures} infrastructure failures\n  ${summary.journal}\n`
  );
}

/** Exit non-zero when an evaluator measured nothing; the journals stay written and resumable. */
export function reportMeasuredNothing(evaluations: ToolEvaluationSummary[]): void {
  for (const evaluation of evaluations.filter((entry) => entry.measured_nothing)) {
    process.stderr.write(
      `error: ${evaluation.tool}/${evaluation.evaluator.id}: ${MEASURED_NOTHING_MESSAGE}\n`,
    );
    process.exitCode = 1;
  }
}

export function toolCommand(tool: LoadedTool): Command {
  const program = new Command()
    .name(`exgen-${tool.manifest.id}`)
    .description(
      `${tool.manifest.title} (Tier ${tool.manifest.tier}). ${tool.manifest.description}`,
    )
    .showHelpAfterError();

  program
    .command("list")
    .description("List this tool's evaluators and which run by default.")
    .option("--json", "emit machine-readable output", false)
    .action((options) => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(tool.manifest, null, 2)}\n`);
        return;
      }
      for (const evaluator of tool.manifest.evaluators) {
        process.stdout.write(
          `${evaluator.default ? "*" : " "} ${evaluator.id.padEnd(28)} ${evaluator.config}\n    ${evaluator.description}\n`,
        );
      }
      process.stdout.write("\n* runs by default\n");
    });

  program
    .command("evaluate")
    .description("Evaluate every candidate of a run with this tool's evaluators.")
    .argument("<run-directory>", "existing generated run directory")
    .option(
      "--evaluator <id>",
      "run only this evaluator; repeat to select several",
      collect,
      [] as string[],
    )
    .option(
      "--config <evaluator-id=path>",
      "use another configuration for one evaluator; repeatable",
      configOverride,
      new Map<string, string>(),
    )
    .option("--retry-infrastructure", "retry only prior evaluator infrastructure failures", false)
    .option("--json", "emit machine-readable summary", false)
    .action(async (runDirectory, options) => {
      const evaluations = await runTool(tool, {
        runDirectory,
        evaluators: options.evaluator,
        configOverrides: options.config,
        retryInfrastructure: options.retryInfrastructure,
        ...(options.json
          ? {}
          : { onEvaluated: (summary) => process.stdout.write(describeEvaluation(summary)) }),
      });
      const release = releaseArguments(evaluations, tool.metricCards);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ tool: tool.manifest.id, evaluations, release_arguments: release }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`\nRelease arguments:\n  ${release.join(" ")}\n`);
      }
      reportMeasuredNothing(evaluations);
    });

  return program;
}

/** Entry point for `tools/<tool>/cli.ts`. */
export async function runToolCli(directory: string, argv = process.argv): Promise<void> {
  const tool = await loadTool(directory);
  try {
    await toolCommand(tool).parseAsync(argv);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
