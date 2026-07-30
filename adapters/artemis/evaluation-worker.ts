import { z } from "zod";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
} from "../../src/evaluation/contracts.ts";
import { targetSchema } from "../../src/contracts.ts";
import { artemisParametersSchema } from "./config.ts";
import { evaluateCandidateWithArtemis } from "./evaluation.ts";

const envelopeSchema = z
  .object({
    request: evaluationRequestSchema,
    options: z
      .object({
        parameters: artemisParametersSchema,
        evidence_root: z.string().min(1),
        target: targetSchema,
      })
      .strict(),
  })
  .strict();

const MAXIMUM_INPUT_BYTES = 1024 * 1024;

async function readInput(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = new Uint8Array(chunk);
    length += bytes.byteLength;
    if (length > MAXIMUM_INPUT_BYTES) {
      throw new Error(`evaluation worker input exceeds ${MAXIMUM_INPUT_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  const input = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(input);
}

async function main(): Promise<void> {
  const envelope = envelopeSchema.parse(JSON.parse(await readInput()));
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("evaluation worker was terminated"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const response = await evaluateCandidateWithArtemis(
      envelope.request,
      { signal: controller.signal },
      {
        parameters: envelope.options.parameters,
        evidenceRoot: envelope.options.evidence_root,
        target: envelope.options.target,
      },
    );
    process.stdout.write(`${JSON.stringify(evaluationResponseSchema.parse(response))}\n`);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

await main();
