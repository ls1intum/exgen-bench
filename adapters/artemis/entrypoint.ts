import { join, resolve } from "node:path";
import { z } from "zod";
import {
  generatorDescriptorSchema,
  generationRequestSchema,
  generationResponseSchema,
  type GeneratorDescriptor,
} from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import { ArtemisGenerator } from "./client.ts";
import { artemisParametersSchema } from "./config.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export async function runArtemisAdapter(
  descriptor: Pick<GeneratorDescriptor, "id" | "revision" | "capabilities">,
): Promise<void> {
  if (process.argv[2] === "describe" && process.argv[3] === "--json") {
    process.stdout.write(
      `${JSON.stringify(
        generatorDescriptorSchema.parse({
          protocol_version: "1",
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
          parameters_schema: z.toJSONSchema(artemisParametersSchema, {
            target: "draft-2020-12",
          }),
        }),
      )}\n`,
    );
    return;
  }

  const command = process.argv[2];
  if (command !== "generate" && command !== "recover") {
    throw new Error(
      "expected 'describe --json', 'generate --request PATH --output DIRECTORY', or 'recover --request PATH --output DIRECTORY'",
    );
  }

  const request = generationRequestSchema.parse(
    await Bun.file(resolve(option("--request"))).json(),
  );
  artemisParametersSchema.parse(request.parameters);
  const outputDirectory = resolve(option("--output"));
  if (resolve(request.output_dir) !== outputDirectory) {
    throw new Error("request output_dir does not match --output");
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("adapter received a termination signal"));
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
}
