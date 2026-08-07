import { z } from "zod";
import { readResponseTextBounded } from "../../src/core/files.ts";

export interface ModelClaimJudgement {
  claim: string;
  witnessed: boolean;
  rationale: string;
}

export type ModelLayerOutcome =
  | { status: "ok"; claims: ModelClaimJudgement[] }
  | { status: "failed"; message: string };

export type Completion = (prompt: string) => Promise<string>;

const MAXIMUM_CLAIMS = 24;
const MAXIMUM_STATEMENT_CHARACTERS = 12_000;
const MAXIMUM_TEST_CHARACTERS = 24_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

// Loose: a provider adding a key must not discard the whole layer.
const judgementSchema = z.looseObject({
  claims: z
    .array(
      z.looseObject({
        claim: z.string().min(1).max(400),
        witnessed: z.boolean(),
        rationale: z.string().min(1).max(400),
      }),
    )
    .max(MAXIMUM_CLAIMS),
});

const MODEL_PROMPT_PREFACE = [
  "You extract normative claims from a programming-exercise problem statement and decide whether",
  "the supplied JUnit test suite witnesses each one. A claim is witnessed only when an assertion",
  "would fail if the claim were violated. Running the code is not enough: a test that merely calls",
  "the member exercises it but does not witness the claim.",
  'Answer with JSON only: {"claims":[{"claim":string,"witnessed":boolean,"rationale":string}]}.',
  `Report at most ${MAXIMUM_CLAIMS} claims, most important first.`,
].join(" ");

function buildPrompt(problemStatement: string, testSource: string): string {
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
      claims: parsed.claims,
    };
  } catch (error) {
    return {
      status: "failed",
      message: `model-assisted layer failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const completionSchema = z.looseObject({
  choices: z
    .array(z.looseObject({ message: z.looseObject({ content: z.string().nullish() }) }))
    .min(1),
});

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
    const completion = completionSchema.parse(
      JSON.parse(await readResponseTextBounded(response, MAXIMUM_RESPONSE_BYTES)),
    );
    return completion.choices[0]?.message.content ?? "";
  };
}
