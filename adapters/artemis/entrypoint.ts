import { join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { z } from "zod";
import {
  GENERATION_PROTOCOL_VERSION,
  generatorDescriptorSchema,
  generationRequestSchema,
  generationResponseSchema,
  type GeneratorDescriptor,
} from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { ArtemisGenerator } from "./client.ts";
import { artemisParametersSchema } from "./config.ts";

export function cliPath(value: string): string {
  if (value.startsWith("-")) throw new InvalidArgumentError("expected a path, not another option");
  return value;
}

export function cliPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new InvalidArgumentError("expected a positive integer");
  return parsed;
}

export async function runArtemisAdapter(
  descriptor: Pick<GeneratorDescriptor, "id" | "revision" | "capabilities">,
  argv: string[] = process.argv,
): Promise<void> {
  const program = new Command()
    .name("artemis")
    .description("exgen generator adapter for the Artemis Hyperion exercise generation feature");

  program
    .command("describe")
    .requiredOption("--json", "emit the generator descriptor as JSON")
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          generatorDescriptorSchema.parse({
            protocol_version: GENERATION_PROTOCOL_VERSION,
            kind: "generator",
            id: descriptor.id,
            version: "1",
            revision: descriptor.revision,
            runtime: {
              name: "bun",
              version: Bun.version,
              revision: Bun.revision,
            },
            capabilities: descriptor.capabilities,
            // Operator-authored parameters use Zod's input projection.
            parameters_schema: z.toJSONSchema(artemisParametersSchema, {
              target: "draft-2020-12",
              io: "input",
            }),
          }),
        )}\n`,
      );
    });

  for (const command of ["generate", "recover"] as const) {
    program
      .command(command)
      .requiredOption("--request <path>", "generation request JSON", cliPath)
      .requiredOption("--output <path>", "attempt output directory", cliPath)
      .action(async (options) => {
        const request = generationRequestSchema.parse(
          await Bun.file(resolve(options.request)).json(),
        );
        const outputDirectory = resolve(options.output);
        if (resolve(request.output_dir) !== outputDirectory) {
          throw new Error("request output_dir does not match --output");
        }
        const controller = new AbortController();
        const abort = (): void =>
          controller.abort(new Error("adapter received a termination signal"));
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          const generator = new ArtemisGenerator(request, outputDirectory);
          if (command === "recover") {
            await generator.recover(controller.signal);
            return;
          }
          const response = await generator.generate(controller.signal);
          await writeJsonAtomic(
            join(outputDirectory, "response.json"),
            generationResponseSchema.parse(response),
          );
        } finally {
          process.removeListener("SIGINT", abort);
          process.removeListener("SIGTERM", abort);
        }
      });
  }

  if (argv.length <= 2) {
    process.stdout.write(program.helpInformation());
    return;
  }
  await program.parseAsync(argv);
}
