export const TRACE_ID = "1".repeat(32);
export const OTHER_TRACE_ID = "2".repeat(32);
export const ROOT_SPAN_ID = "a".repeat(16);
export const MODEL_SPAN_ID = "b".repeat(16);
export const JOB_ID_ATTRIBUTE = "artemis.hyperion.job.id";
export const JOB_ID = "job-1";
export const ABSENT_PARENT_SPAN_ID = "0".repeat(16);

export type AnyValue = Record<string, unknown>;
export type Attributes = Record<string, AnyValue>;

export function text(value: string): AnyValue {
  return { stringValue: value };
}

export function integer(value: number | string): AnyValue {
  return { intValue: value };
}

export function json(value: unknown): AnyValue {
  return { stringValue: JSON.stringify(value) };
}

/**
 * Every value below is a sample of the live Spring Boot 4.1 wire: 19-digit nanosecond timestamps,
 * numeric status and kind enums, `flags` 259, and `stringValue` for all 165,112 attribute values.
 */
// Recorded from the wire, and deliberately not round: neither value is a multiple of 256, so
// neither survives a JSON-number round trip at this magnitude.
export const START_TIME_UNIX_NANO = "1785534511734643676";
export const END_TIME_UNIX_NANO = "1785534512891204133";
export const SAMPLED_FLAGS = 259;

export interface SpanOptions {
  spanId: string;
  name?: string;
  traceId?: string;
  parentSpanId?: string;
  kind?: number;
  flags?: number;
  attributes?: Attributes;
  droppedAttributesCount?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  correlated?: boolean;
}

export function span(options: SpanOptions): Record<string, unknown> {
  const attributes: Attributes = {
    ...(options.correlated ? { [JOB_ID_ATTRIBUTE]: text(JOB_ID) } : {}),
    ...(options.attributes ?? {}),
  };
  return {
    traceId: options.traceId ?? TRACE_ID,
    spanId: options.spanId,
    ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
    name: options.name ?? "span",
    kind: options.kind ?? 1,
    flags: options.flags ?? SAMPLED_FLAGS,
    startTimeUnixNano: options.startTimeUnixNano ?? START_TIME_UNIX_NANO,
    endTimeUnixNano: options.endTimeUnixNano ?? END_TIME_UNIX_NANO,
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })),
    ...(options.droppedAttributesCount === undefined
      ? {}
      : { droppedAttributesCount: options.droppedAttributesCount }),
    status: { code: 1 },
  };
}

export function rootSpan(options: Partial<SpanOptions> = {}): Record<string, unknown> {
  return span({
    spanId: ROOT_SPAN_ID,
    name: "exercise generation",
    kind: 2,
    correlated: true,
    ...options,
  });
}

export interface TokenOptions {
  input?: number | string | AnyValue;
  output?: number | string | AnyValue;
  cacheRead?: number | string | AnyValue;
  cacheCreation?: number | string | AnyValue;
  reasoning?: number | string | AnyValue;
}

/**
 * Spring Boot 4.1 carries GenAI counters as Micrometer KeyValues, so the reference producer emits
 * every one of them as `stringValue`. `intString` and `intNumber` are the OTLP/JSON forms other
 * producers use; all three must normalize to the same evidence.
 */
export type TokenEncoding = "string" | "intString" | "intNumber";

export interface ModelSpanOptions extends Partial<SpanOptions> {
  operation?: string | false;
  responseId?: string | false;
  tokens?: TokenOptions;
  tokenEncoding?: TokenEncoding;
  content?: boolean;
  finishReason?: string;
}

// The reference producer reports no cache or reasoning detail on any model span, so absence is the
// default here and the optional-aggregate suppression path is the one fixtures exercise by default.
const DEFAULT_TOKENS: TokenOptions = { input: 100, output: 20 };

function token(
  value: number | string | AnyValue | undefined,
  encoding: TokenEncoding,
): AnyValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object") return value;
  if (encoding === "string") return text(String(value));
  return integer(encoding === "intNumber" ? Number(value) : String(value));
}

export function inputMessages(content = "input"): AnyValue {
  return json([
    { role: "system", parts: [{ type: "text", content: "You generate exercises." }] },
    { role: "user", parts: [{ type: "text", content }] },
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "call-0", name: "read_file", arguments: {} }],
    },
    {
      role: "tool",
      parts: [{ type: "tool_call_response", id: "call-0", response: "public class Sort {}" }],
    },
  ]);
}

export function outputMessages(finishReason = "TOOL_CALLS"): AnyValue {
  return json([
    {
      role: "assistant",
      parts: [
        { type: "reasoning", content: "provider-exposed summary" },
        { type: "text", content: "Writing the solution." },
        { type: "tool_call", id: "call-1", name: "write_file", arguments: {} },
      ],
      finish_reason: finishReason,
    },
  ]);
}

export function modelSpan(options: ModelSpanOptions = {}): Record<string, unknown> {
  const tokens = options.tokens ?? DEFAULT_TOKENS;
  const encoding = options.tokenEncoding ?? "string";
  const entries: Array<[string, AnyValue | undefined]> = [
    [
      "gen_ai.operation.name",
      options.operation === false ? undefined : text(options.operation ?? "chat"),
    ],
    [
      "gen_ai.response.id",
      options.responseId === false ? undefined : text(options.responseId ?? "request-1"),
    ],
    ["gen_ai.input.messages", options.content === false ? undefined : inputMessages()],
    [
      "gen_ai.output.messages",
      options.content === false ? undefined : outputMessages(options.finishReason),
    ],
    ["gen_ai.usage.input_tokens", token(tokens.input, encoding)],
    ["gen_ai.usage.output_tokens", token(tokens.output, encoding)],
    ["gen_ai.usage.cache_read.input_tokens", token(tokens.cacheRead, encoding)],
    ["gen_ai.usage.cache_creation.input_tokens", token(tokens.cacheCreation, encoding)],
    ["gen_ai.usage.reasoning.output_tokens", token(tokens.reasoning, encoding)],
  ];
  const attributes: Attributes = {};
  for (const [key, value] of entries) if (value !== undefined) attributes[key] = value;
  return span({
    spanId: MODEL_SPAN_ID,
    name: "chat openai/gpt-oss-120b",
    kind: 3,
    parentSpanId: ROOT_SPAN_ID,
    ...options,
    attributes: { ...attributes, ...(options.attributes ?? {}) },
  });
}

export function batch(...spans: Array<Record<string, unknown>>): string {
  return `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: text("Artemis") }] },
        schemaUrl: "https://opentelemetry.io/schemas/1.37.0",
        scopeSpans: [
          {
            scope: { name: "org.springframework.ai.chat.observation", version: "1.1.0" },
            schemaUrl: "https://opentelemetry.io/schemas/1.37.0",
            spans,
          },
        ],
      },
    ],
  })}\n`;
}

export function trace(model: ModelSpanOptions = {}): string {
  return batch(rootSpan(), modelSpan(model));
}
