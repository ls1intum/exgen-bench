import { z } from "zod";

import { readResponseTextBounded } from "../../../../src/core/files.ts";
import type { ChatMessage } from "./prompt.ts";

/**
 * The model behind the judge. The real transport speaks the OpenAI-compatible chat-completions API,
 * as `adapters/openai-compatible` does: endpoint and model come from configuration, the credential
 * only from the environment variable the configuration names. Tests use a scripted transport.
 */

export interface Completion {
  content: string | null;
  finishReason?: string;
  providerRequestId?: string;
  /** The model the provider reports having used, which can differ from the one requested. */
  model?: string;
  usage?: Record<string, unknown>;
}

export interface TransportDescription {
  kind: string;
  provider: string;
  requested_model: string;
  parameters: Record<string, unknown>;
}

export interface Transport {
  describe(): TransportDescription;
  complete(messages: ChatMessage[]): Promise<Completion>;
}

/** A failed call. Retryable failures (network, timeout, 408/409/425/429/5xx) may be tried again. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const DEFAULT_SETUP_READS = { enabled: true, max_files: 12 };

export const judgeConfigSchema = z.strictObject({
  schema_version: z.literal("1"),
  provider: z.strictObject({
    base_url: z.url(),
    api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  }),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0),
  max_output_tokens: z.number().int().positive().default(4000),
  seed: z.number().int().optional(),
  /** `json_object` asks the provider for JSON mode; `none` relies on the instructions alone. */
  response_format: z.enum(["json_object", "none"]).default("json_object"),
  timeout_ms: z.number().int().positive().default(180_000),
  /** Attempts per call for technical failures only. An invalid answer is never retried. */
  max_attempts: z.number().int().min(1).max(5).default(2),
  setup_reads: z
    .strictObject({
      enabled: z.boolean().default(DEFAULT_SETUP_READS.enabled),
      max_files: z.number().int().min(1).max(20).default(DEFAULT_SETUP_READS.max_files),
    })
    .default(DEFAULT_SETUP_READS),
});

export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const RETRYABLE = new Set([408, 409, 425, 429]);

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

export class OpenAiCompatibleTransport implements Transport {
  private readonly endpoint: string;

  constructor(
    private readonly config: JudgeConfig,
    private readonly apiKey: string,
  ) {
    this.endpoint = `${config.provider.base_url.replace(/\/+$/, "")}/chat/completions`;
  }

  describe(): TransportDescription {
    return {
      kind: "openai-compatible",
      provider: new URL(this.config.provider.base_url).host,
      requested_model: this.config.model,
      parameters: {
        temperature: this.config.temperature,
        max_output_tokens: this.config.max_output_tokens,
        seed: this.config.seed ?? null,
        response_format: this.config.response_format,
        timeout_ms: this.config.timeout_ms,
      },
    };
  }

  /** Keep the credential out of every message that leaves this class. */
  private scrub(text: string): string {
    return this.apiKey === "" ? text : text.split(this.apiKey).join("[credential]");
  }

  async complete(messages: ChatMessage[]): Promise<Completion> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.max_output_tokens,
          ...(this.config.seed === undefined ? {} : { seed: this.config.seed }),
          ...(this.config.response_format === "json_object"
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
        signal: AbortSignal.timeout(this.config.timeout_ms),
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new TransportError(this.scrub(`request failed: ${message}`), true);
    }
    let completion: ChatCompletion;
    try {
      completion = JSON.parse(
        await readResponseTextBounded(response, MAXIMUM_RESPONSE_BYTES),
      ) as ChatCompletion;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError(
        this.scrub(`HTTP ${response.status}, unreadable body: ${message}`),
        response.status >= 500 || RETRYABLE.has(response.status),
        response.status,
      );
    }
    if (!response.ok) {
      const detail = completion.error?.message ?? "no error message";
      throw new TransportError(
        this.scrub(`HTTP ${response.status}: ${detail}`.slice(0, 500)),
        response.status >= 500 || RETRYABLE.has(response.status),
        response.status,
      );
    }
    const choice = completion.choices?.[0];
    return {
      content: choice?.message?.content ?? null,
      ...(choice?.finish_reason === undefined ? {} : { finishReason: choice.finish_reason }),
      ...(completion.id === undefined ? {} : { providerRequestId: completion.id }),
      ...(completion.model === undefined ? {} : { model: completion.model }),
      ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    };
  }
}

/** A transport that answers from a script, for tests and offline smoke runs. */
export class ScriptedTransport implements Transport {
  readonly calls: ChatMessage[][] = [];

  constructor(
    private readonly reply: (
      messages: ChatMessage[],
      call: number,
    ) => Completion | Promise<Completion>,
    private readonly name = "scripted",
  ) {}

  describe(): TransportDescription {
    return { kind: "scripted", provider: "local", requested_model: this.name, parameters: {} };
  }

  async complete(messages: ChatMessage[]): Promise<Completion> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return this.reply(messages, this.calls.length - 1);
  }
}
