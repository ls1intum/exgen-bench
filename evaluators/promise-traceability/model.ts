import { z } from "zod";

export interface ModelClaimJudgement {
  claim: string;
  witnessed: boolean;
  rationale: string;
}

export type ModelLayerOutcome =
  | { status: "ok"; claims: ModelClaimJudgement[] }
  | { status: "failed"; message: string };

export interface ModelLayerReport {
  claims: ModelClaimJudgement[];
}

export type Completion = (prompt: string) => Promise<string>;

const MAXIMUM_CLAIMS = 24;
const MAXIMUM_STATEMENT_CHARACTERS = 12_000;
const MAXIMUM_TEST_CHARACTERS = 24_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

const judgementSchema = z.strictObject({
  claims: z
    .array(
      z.strictObject({
        claim: z.string().min(1).max(400),
        exercised: z.boolean(),
        rationale: z.string().min(1).max(400),
      }),
    )
    .max(MAXIMUM_CLAIMS),
});

export const MODEL_PROMPT_PREFACE = [
  "You extract normative claims from a programming-exercise problem statement and decide whether",
  "the supplied JUnit test suite exercises each one. A claim is exercised only when an assertion",
  "would fail if the claim were violated; a test that merely calls the member does not count.",
  'Answer with JSON only: {"claims":[{"claim":string,"exercised":boolean,"rationale":string}]}.',
  `Report at most ${MAXIMUM_CLAIMS} claims, most important first.`,
].join(" ");

export function buildPrompt(problemStatement: string, testSource: string): string {
  return [
    MODEL_PROMPT_PREFACE,
    "",
    "## Problem statement",
    problemStatement.slice(0, MAXIMUM_STATEMENT_CHARACTERS),
    "",
    "## Test suite",
    testSource.slice(0, MAXIMUM_TEST_CHARACTERS),
  ].join("\n");
}

function extractJson(completion: string): unknown {
  const fenced = completion.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? completion;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("model returned no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function judgeClaims(
  complete: Completion,
  problemStatement: string,
  testSource: string,
): Promise<ModelLayerOutcome> {
  try {
    const parsed = judgementSchema.parse(
      extractJson(await complete(buildPrompt(problemStatement, testSource))),
    );
    return {
      status: "ok",
      claims: parsed.claims.map((claim) => ({
        claim: claim.claim,
        witnessed: claim.exercised,
        rationale: claim.rationale,
      })),
    };
  } catch (error) {
    return {
      status: "failed",
      message: `model-assisted layer failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ChatCompletionOptions {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  timeoutMs: number;
}

export function chatCompletion(options: ChatCompletionOptions): Completion {
  return async (prompt) => {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`provider responded ${response.status}`);
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAXIMUM_RESPONSE_BYTES) {
      throw new Error(`provider response exceeds ${MAXIMUM_RESPONSE_BYTES} bytes`);
    }
    const completion = z
      .object({
        choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
      })
      .parse(JSON.parse(new TextDecoder().decode(body)));
    return completion.choices[0]?.message.content ?? "";
  };
}
