import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { canonicalJson } from "../core/canonical.ts";

const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
const CACHE_CREATION_INPUT_TOKENS = "gen_ai.usage.cache_creation.input_tokens";
const REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens";
const TOTAL_TOKENS = "gen_ai.usage.total_tokens";
const RESPONSE_ID = "gen_ai.response.id";
const OPERATION_NAME = "gen_ai.operation.name";
const INPUT_MESSAGES = "gen_ai.input.messages";
const OUTPUT_MESSAGES = "gen_ai.output.messages";

// Attribute names, inference operation names, and finish-reason values are transcribed from the
// OpenTelemetry GenAI semantic conventions (Development stability); the published JavaScript
// constants for them are deprecated and no package ingests OTLP/JSON.
const CONTENT_ATTRIBUTES = [
  INPUT_MESSAGES,
  OUTPUT_MESSAGES,
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
] as const;
const SAFE_METADATA_ATTRIBUTES = new Set([
  INPUT_TOKENS,
  OUTPUT_TOKENS,
  CACHE_READ_INPUT_TOKENS,
  CACHE_CREATION_INPUT_TOKENS,
  REASONING_OUTPUT_TOKENS,
  TOTAL_TOKENS,
  RESPONSE_ID,
  OPERATION_NAME,
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
]);
const INTEGER_ATTRIBUTES = new Set([
  INPUT_TOKENS,
  OUTPUT_TOKENS,
  CACHE_READ_INPUT_TOKENS,
  CACHE_CREATION_INPUT_TOKENS,
  REASONING_OUTPUT_TOKENS,
  TOTAL_TOKENS,
]);
const MODEL_OPERATIONS = new Set(["chat", "text_completion", "generate_content"]);
const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_call",
  "compaction",
  "error",
]);
// Spring AI forwards the provider SDK's stop-reason name verbatim, so the wire dialect follows the
// backing provider: OpenAI ChatCompletion.Choice.FinishReason and Responses incomplete_details,
// Anthropic stop_reason, Gemini Candidate.FinishReason. Values that map onto exactly one convention
// value are aliased; the rest are recorded unmapped, because the convention types finish_reason as
// `anyOf [FinishReason, string]` (semantic-conventions-genai, model/gen-ai/gen-ai-output-messages.json)
// and no reconciliation depends on it.
const FINISH_REASON_ALIASES = new Map([
  ["tool_calls", "tool_call"],
  ["function_call", "tool_call"],
  ["max_output_tokens", "length"],
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["max_tokens", "length"],
  ["tool_use", "tool_call"],
  ["refusal", "content_filter"],
  ["safety", "content_filter"],
  ["recitation", "content_filter"],
  ["blocklist", "content_filter"],
  ["prohibited_content", "content_filter"],
  ["spii", "content_filter"],
  ["image_safety", "content_filter"],
  ["malformed_function_call", "error"],
]);

const ABSENT_SPAN_ID = "0".repeat(16);
const NEWLINE = 0x0a;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const DECODER = new TextDecoder("utf-8", { fatal: true });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface NormalizedOtlpEvent {
  name: string;
  time_unix_nano: string;
  attributes: Record<string, JsonValue>;
  dropped_attributes_count: number;
}

export interface NormalizedOtlpLink {
  trace_id: string;
  span_id: string;
  trace_state?: string;
  flags?: number;
  attributes: Record<string, JsonValue>;
  dropped_attributes_count: number;
}

export interface NormalizedOtlpSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  trace_state?: string;
  flags?: number;
  name: string;
  kind?: string | number;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  resource_attributes: Record<string, JsonValue>;
  resource_schema_url?: string;
  instrumentation_scope?: {
    name: string;
    version?: string;
    attributes?: Record<string, JsonValue>;
  };
  instrumentation_scope_schema_url?: string;
  attributes: Record<string, JsonValue>;
  dropped_attributes_count: number;
  events: NormalizedOtlpEvent[];
  dropped_events_count: number;
  links: NormalizedOtlpLink[];
  dropped_links_count: number;
  status?: JsonValue;
}

export interface GenAiUsage {
  modelCalls: number;
  /** Tool calls requested in fresh model outputs. This does not claim that tool execution succeeded. */
  toolCalls?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface OtlpTraceEvidence {
  profile: "exgen.otel.genai.v3";
  source: string;
  source_segment: {
    byte_start: number;
    byte_end: number;
    sha256: string;
  };
  correlation: { attribute: string; value: string };
  trace_id: string;
  correlated_span_ids: string[];
  span_count: number;
  model_span_count: number;
  usage_reconciliation: "verified" | "partially_observable" | "not_requested";
  /**
   * `not_observable` records an expected value the trace cannot see because the attribute is not
   * reported on every model span. It is a missingness classification, not a disagreement.
   */
  usage_reconciliation_fields: { compared: string[]; not_observable: string[] };
  provider_request_id_reconciliation: "verified" | "not_requested";
  observed_usage: GenAiUsage;
  usage_attribute_coverage: {
    output_messages_for_tool_calls: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
  };
  observed_provider_request_ids: string[];
  completeness: {
    stable_poll_count: number;
    duplicate_span_ids: number;
    orphan_span_count: number;
    dropped_attributes: number;
    dropped_events: number;
    dropped_links: number;
  };
  content_capture: "metadata_only" | "content_present";
  content_span_count: number;
  model_message_span_count: number;
  unmapped_finish_reasons: string[];
  output_content_inventory: {
    text_parts: number;
    reasoning_parts: number;
    reasoning_characters: number;
    tool_call_parts: number;
    other_parts: number;
  };
  spans: NormalizedOtlpSpan[];
}

export interface CaptureOtlpTraceOptions {
  path: string;
  source: string;
  cursor: number;
  maximumBytes: number;
  timeoutMs: number;
  pollIntervalMs: number;
  stablePollCount?: number;
  correlation: { attribute: string; value: string };
  expectedUsage?: GenAiUsage;
  expectedProviderRequestIds?: string[];
  contentPolicy: "required" | "forbidden";
  signal?: AbortSignal;
}

export interface OtlpPreflightResult {
  exported_spans: number;
  decoded_model_spans: number;
  verified: "model_span_decoded" | "delivery_only";
}

export interface WaitForOtlpExportOptions {
  path: string;
  cursor: number;
  maximumBytes: number;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Integer-typed OTLP fields and semconv attributes arrive either as a JSON number or as a decimal
// string: Micrometer KeyValues are string-typed by construction, so the Spring Boot OTLP bridge
// emits every gen_ai counter as stringValue. Both encodings normalize to the same number, which is
// what keeps evidence bytes independent of the producer.
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;
const MAXIMUM_EXACT = Number.MAX_SAFE_INTEGER;

// A JSON number carries a 64-bit integer exactly only up to 2^53-1, and a real nanosecond timestamp
// is ~1.79e18: JSON.parse has already rounded it before this function sees it, so the original
// digits are unrecoverable. Rejecting is the only honest outcome for an evidence plane, and the
// producer has a lossless alternative because OTLP/JSON also permits the decimal string form.
function decimalInteger(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value > MAXIMUM_EXACT)
    throw new Error(
      `OpenTelemetry export sent ${field} as a JSON number that decoded to ${value}, above the ${MAXIMUM_EXACT} exact-integer limit of JSON numbers, so the original value cannot be recovered: send 64-bit integers as decimal strings`,
    );
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : "";
  if (!DECIMAL_INTEGER.test(text))
    throw new Error(
      `OpenTelemetry export has an invalid ${field}: ${JSON.stringify(value)} is not a non-negative decimal integer`,
    );
  return text;
}

function integerValue(value: unknown, field: string): number {
  const parsed = Number(decimalInteger(value, field));
  if (!Number.isSafeInteger(parsed))
    throw new Error(
      `OpenTelemetry export has a ${field} outside the safe integer range: ${JSON.stringify(value)}`,
    );
  return parsed;
}

function isDecimalInteger(value: JsonValue): boolean {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === "string" &&
        DECIMAL_INTEGER.test(value) &&
        Number.isSafeInteger(Number(value));
}

function count(value: unknown, field: string): number {
  return value === undefined ? 0 : integerValue(value, `${field} count`);
}

const ANY_VALUE_KEYS = [
  "stringValue",
  "intValue",
  "doubleValue",
  "boolValue",
  "bytesValue",
  "arrayValue",
  "kvlistValue",
] as const;

function otlpValue(value: unknown, field: string): JsonValue {
  const wrapped = object(value);
  if (!wrapped)
    throw new Error(`OpenTelemetry ${field} does not carry an AnyValue object: ${typeof value}`);
  const present = ANY_VALUE_KEYS.filter(
    (key) => wrapped[key] !== undefined && wrapped[key] !== null,
  );
  if (present.length > 1)
    throw new Error(
      `OpenTelemetry ${field} sets ${present.length} AnyValue fields (${present.join(", ")}) where exactly one is allowed`,
    );
  const key = present[0];
  if (key === undefined) return null;
  const candidate = wrapped[key];
  if (key === "stringValue") {
    if (typeof candidate !== "string")
      throw new Error(`OpenTelemetry ${field} stringValue is not a string: ${typeof candidate}`);
    return candidate;
  }
  if (key === "intValue") {
    const parsed =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^-?\d+$/.test(candidate)
          ? Number(candidate)
          : Number.NaN;
    if (!Number.isSafeInteger(parsed))
      throw new Error(
        `OpenTelemetry ${field} intValue is not a safe 64-bit integer: ${JSON.stringify(candidate)}`,
      );
    return parsed;
  }
  if (key === "doubleValue") {
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    if (!Number.isFinite(parsed))
      throw new Error(
        `OpenTelemetry ${field} doubleValue is not a finite number: ${JSON.stringify(candidate)}`,
      );
    return parsed;
  }
  if (key === "boolValue") {
    if (typeof candidate !== "boolean")
      throw new Error(`OpenTelemetry ${field} boolValue is not a boolean: ${typeof candidate}`);
    return candidate;
  }
  if (key === "bytesValue") {
    if (typeof candidate !== "string")
      throw new Error(`OpenTelemetry ${field} bytesValue is not base64 text: ${typeof candidate}`);
    return { bytes_base64: candidate };
  }
  if (key === "arrayValue") {
    const wrappedArray = object(candidate);
    if (!wrappedArray)
      throw new Error(`OpenTelemetry ${field} arrayValue is not an object: ${typeof candidate}`);
    return array(wrappedArray.values).map((item, index) =>
      otlpValue(item, `${field}.arrayValue[${index}]`),
    );
  }
  const wrappedList = object(candidate);
  if (!wrappedList)
    throw new Error(`OpenTelemetry ${field} kvlistValue is not an object: ${typeof candidate}`);
  return otlpAttributes(wrappedList.values, `${field}.kvlistValue`);
}

function canonicalFinishReason(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.toLowerCase();
  const canonical = FINISH_REASON_ALIASES.get(folded) ?? folded;
  return FINISH_REASONS.has(canonical) ? canonical : undefined;
}

function canonicalOutputMessages(value: JsonValue): JsonValue {
  if (typeof value !== "string") return value;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
  if (!Array.isArray(parsed)) return value;
  let rewritten = false;
  const messages = parsed.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const canonical = canonicalFinishReason(message.finish_reason);
    if (canonical === undefined || canonical === message.finish_reason) return message;
    rewritten = true;
    return { ...message, finish_reason: canonical };
  });
  return rewritten ? JSON.stringify(messages) : value;
}

function normalizedAttribute(key: string, value: JsonValue): JsonValue {
  if (INTEGER_ATTRIBUTES.has(key)) return isDecimalInteger(value) ? Number(value) : value;
  return key === OUTPUT_MESSAGES ? canonicalOutputMessages(value) : value;
}

function otlpAttributes(value: unknown, field: string): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const item of array(value)) {
    const attribute = object(item);
    if (!attribute || typeof attribute.key !== "string" || attribute.key.length === 0)
      throw new Error(`OpenTelemetry ${field} contains a key/value pair without a string key`);
    result[attribute.key] = normalizedAttribute(
      attribute.key,
      otlpValue(attribute.value, `${field} attribute ${attribute.key}`),
    );
  }
  return result;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item) ?? null);
  const record = object(value);
  if (!record) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    const parsed = jsonValue(item);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function requiredHex(value: unknown, field: string, bytes: number): string {
  if (typeof value !== "string" || !new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value))
    throw new Error(
      `OpenTelemetry export has an invalid ${field}: ${JSON.stringify(value)} is not ${bytes * 2} hex characters`,
    );
  return value.toLowerCase();
}

// Nanosecond timestamps exceed the safe integer range, so they stay in their decimal string form.
function requiredTime(value: unknown, field: string): string {
  return decimalInteger(value, field);
}

function optionalFlags(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : integerValue(value, field);
}

function optionalTraceState(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string")
    throw new Error(
      `OpenTelemetry export has an invalid ${field}: ${typeof value} is not a string`,
    );
  return value;
}

function optionalSpanId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = requiredHex(value, field, 8);
  return parsed === ABSENT_SPAN_ID ? undefined : parsed;
}

interface ScopeContext {
  resourceAttributes: Record<string, JsonValue>;
  resourceSchemaUrl?: string;
  scope?: { name: string; version?: string; attributes?: Record<string, JsonValue> };
  scopeSchemaUrl?: string;
}

function normalizeEvent(value: unknown, index: number): NormalizedOtlpEvent {
  const event = object(value);
  if (!event || typeof event.name !== "string" || event.name.length === 0)
    throw new Error(`OpenTelemetry span event[${index}] does not carry a name`);
  return {
    name: event.name,
    time_unix_nano: requiredTime(event.timeUnixNano, `event[${index}].timeUnixNano`),
    attributes: otlpAttributes(event.attributes, `event[${index}]`),
    dropped_attributes_count: count(event.droppedAttributesCount, `event[${index}] dropped`),
  };
}

function normalizeLink(value: unknown, index: number): NormalizedOtlpLink {
  const link = object(value);
  if (!link) throw new Error(`OpenTelemetry span link[${index}] is not an object`);
  const traceState = optionalTraceState(link.traceState, `link[${index}].traceState`);
  const flags = optionalFlags(link.flags, `link[${index}].flags`);
  return {
    trace_id: requiredHex(link.traceId, `link[${index}].traceId`, 16),
    span_id: requiredHex(link.spanId, `link[${index}].spanId`, 8),
    ...(traceState === undefined ? {} : { trace_state: traceState }),
    ...(flags === undefined ? {} : { flags }),
    attributes: otlpAttributes(link.attributes, `link[${index}]`),
    dropped_attributes_count: count(link.droppedAttributesCount, `link[${index}] dropped`),
  };
}

function normalizeSpan(value: unknown, context: ScopeContext): NormalizedOtlpSpan {
  const span = object(value);
  if (!span || typeof span.name !== "string" || span.name.length === 0)
    throw new Error("OpenTelemetry export contains a span without a name");
  const parentSpanId = optionalSpanId(span.parentSpanId, "parentSpanId");
  const traceState = optionalTraceState(span.traceState, "traceState");
  const flags = optionalFlags(span.flags, "flags");
  const kind =
    typeof span.kind === "string" || typeof span.kind === "number" ? span.kind : undefined;
  return {
    trace_id: requiredHex(span.traceId, "traceId", 16),
    span_id: requiredHex(span.spanId, "spanId", 8),
    ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
    ...(traceState === undefined ? {} : { trace_state: traceState }),
    ...(flags === undefined ? {} : { flags }),
    name: span.name,
    ...(kind === undefined ? {} : { kind }),
    start_time_unix_nano: requiredTime(span.startTimeUnixNano, "startTimeUnixNano"),
    end_time_unix_nano: requiredTime(span.endTimeUnixNano, "endTimeUnixNano"),
    resource_attributes: context.resourceAttributes,
    ...(context.resourceSchemaUrl === undefined
      ? {}
      : { resource_schema_url: context.resourceSchemaUrl }),
    ...(context.scope ? { instrumentation_scope: context.scope } : {}),
    ...(context.scopeSchemaUrl === undefined
      ? {}
      : { instrumentation_scope_schema_url: context.scopeSchemaUrl }),
    attributes: otlpAttributes(span.attributes, "span"),
    dropped_attributes_count: count(span.droppedAttributesCount, "span attribute"),
    events: array(span.events).map((item, index) => normalizeEvent(item, index)),
    dropped_events_count: count(span.droppedEventsCount, "span event"),
    links: array(span.links).map((item, index) => normalizeLink(item, index)),
    dropped_links_count: count(span.droppedLinksCount, "span link"),
    ...(span.status === undefined ? {} : { status: jsonValue(span.status) ?? null }),
  };
}

function schemaUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function spansFromLine(line: string): NormalizedOtlpSpan[] {
  let request: Record<string, unknown>;
  try {
    const parsed = object(JSON.parse(line));
    if (!parsed) throw new Error("record is not a JSON object");
    request = parsed;
  } catch (error) {
    throw new Error(`OpenTelemetry file exporter emitted invalid JSON: ${String(error)}`);
  }
  const spans: NormalizedOtlpSpan[] = [];
  for (const resourceSpanValue of array(request.resourceSpans)) {
    const resourceSpan = object(resourceSpanValue);
    const resourceAttributes = otlpAttributes(
      object(resourceSpan?.resource)?.attributes,
      "resource",
    );
    const resourceSchemaUrl = schemaUrl(resourceSpan?.schemaUrl);
    for (const scopeSpanValue of array(resourceSpan?.scopeSpans)) {
      const scopeSpan = object(scopeSpanValue);
      const scope = object(scopeSpan?.scope);
      const scopeAttributes = scope
        ? otlpAttributes(scope.attributes, "instrumentation scope")
        : {};
      const scopeSchemaUrl = schemaUrl(scopeSpan?.schemaUrl);
      const context: ScopeContext = {
        resourceAttributes,
        ...(resourceSchemaUrl === undefined ? {} : { resourceSchemaUrl }),
        ...(typeof scope?.name === "string" && scope.name.length > 0
          ? {
              scope: {
                name: scope.name,
                ...(typeof scope.version === "string" && scope.version.length > 0
                  ? { version: scope.version }
                  : {}),
                ...(Object.keys(scopeAttributes).length > 0 ? { attributes: scopeAttributes } : {}),
              },
            }
          : {}),
        ...(scopeSchemaUrl === undefined ? {} : { scopeSchemaUrl }),
      };
      for (const span of array(scopeSpan?.spans)) spans.push(normalizeSpan(span, context));
    }
  }
  return spans;
}

function compareSpans(left: NormalizedOtlpSpan, right: NormalizedOtlpSpan): number {
  const start =
    left.start_time_unix_nano.length - right.start_time_unix_nano.length ||
    left.start_time_unix_nano.localeCompare(right.start_time_unix_nano);
  return start !== 0 ? start : left.span_id.localeCompare(right.span_id);
}

interface FileStatus {
  size: number;
  identity?: string;
}

async function fileStatus(path: string): Promise<FileStatus> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile())
      throw new Error(`OpenTelemetry trace path is not a regular file: ${path}`);
    return { size: metadata.size, identity: `${metadata.dev}:${metadata.ino}` };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { size: 0 };
    throw error;
  }
}

export async function otlpFileCursor(path: string): Promise<number> {
  return (await fileStatus(path)).size;
}

function* lineSlices(bytes: Uint8Array): Generator<Uint8Array> {
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== NEWLINE) continue;
    if (index > start) yield bytes.subarray(start, index);
    start = index + 1;
  }
}

function decodeLine(bytes: Uint8Array): string {
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new Error("OpenTelemetry file exporter emitted a record that is not valid UTF-8");
  }
}

interface RetainedSpan {
  span: NormalizedOtlpSpan;
  canonical: string;
}

class OtlpFileScan {
  private cursor: number;
  private identity: string | undefined;
  private readonly hasher = new Bun.CryptoHasher("sha256");
  private readonly retained = new Map<string, RetainedSpan>();
  private readonly correlated = new Set<string>();
  private traceId: string | undefined;
  private pendingRescanTo: number | undefined;
  private duplicates = 0;
  private retainedBytes = 0;
  private scannedSpans = 0;
  private decodedModelSpans = 0;
  private consumedBytes = 0;

  constructor(
    private readonly path: string,
    private readonly start: number,
    private readonly maximumBytes: number,
    private readonly correlation?: { attribute: string; value: string },
  ) {
    this.cursor = start;
  }

  get byteEnd(): number {
    return this.cursor;
  }

  get sha256(): string {
    return this.hasher.copy().digest("hex");
  }

  get correlatedTraceId(): string | undefined {
    return this.traceId;
  }

  get correlatedSpanIds(): string[] {
    return [...this.correlated];
  }

  get duplicateSpanIds(): number {
    return this.duplicates;
  }

  get scannedSpanCount(): number {
    return this.scannedSpans;
  }

  get decodedModelSpanCount(): number {
    return this.decodedModelSpans;
  }

  spans(): NormalizedOtlpSpan[] {
    return [...this.retained.values()].map((entry) => entry.span).sort(compareSpans);
  }

  async poll(): Promise<void> {
    const status = await fileStatus(this.path);
    if (this.identity === undefined) this.identity = status.identity;
    else if (status.identity !== undefined && status.identity !== this.identity)
      throw new Error(
        `OpenTelemetry trace file was replaced during the attempt: device/inode ${this.identity} became ${status.identity}`,
      );
    if (status.size < this.cursor)
      throw new Error(
        `OpenTelemetry trace file was truncated during the attempt: size ${status.size} is below the consumed byte offset ${this.cursor}`,
      );
    while (this.cursor < status.size) {
      const limit = Math.min(status.size, this.cursor + READ_CHUNK_BYTES);
      const chunk = await Bun.file(this.path).slice(this.cursor, limit).bytes();
      if (chunk.byteLength === 0) break;
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        if (chunk.byteLength >= READ_CHUNK_BYTES)
          throw new Error(
            `OpenTelemetry file exporter emitted a record longer than the ${READ_CHUNK_BYTES} byte read window without a newline`,
          );
        break;
      }
      const complete = chunk.subarray(0, lastNewline + 1);
      let offset = this.cursor;
      for (const line of lineSlices(complete)) {
        this.ingest(line, offset);
        offset += line.byteLength + 1;
      }
      this.hasher.update(complete);
      this.cursor += complete.byteLength;
      this.consumedBytes += complete.byteLength;
      if (this.correlation === undefined && this.consumedBytes > this.maximumBytes)
        throw new Error(
          `OpenTelemetry preflight scan exceeds the ${this.maximumBytes} byte max_bytes_per_attempt limit: ${this.consumedBytes} bytes read`,
        );
    }
    if (this.pendingRescanTo !== undefined) {
      const end = this.pendingRescanTo;
      this.pendingRescanTo = undefined;
      await this.rescan(end);
    }
  }

  private ingest(line: Uint8Array, offset: number): void {
    const spans = spansFromLine(decodeLine(line));
    this.scannedSpans += spans.length;
    if (!this.correlation) {
      this.decodedModelSpans += modelSpans(spans).length;
      return;
    }
    for (const span of spans) {
      if (span.attributes[this.correlation.attribute] !== this.correlation.value) continue;
      if (this.traceId === undefined) {
        this.traceId = span.trace_id;
        if (offset > this.start) this.pendingRescanTo = offset;
      } else if (span.trace_id !== this.traceId) {
        throw new Error(
          `OpenTelemetry exported multiple traces for correlation ${this.correlation.value}: ${this.traceId} and ${span.trace_id}`,
        );
      }
      this.correlated.add(span.span_id);
    }
    this.retain(spans, line.byteLength + 1);
  }

  private retain(spans: NormalizedOtlpSpan[], bytes: number): void {
    if (this.traceId === undefined) return;
    let retainedHere = false;
    for (const span of spans) {
      if (span.trace_id !== this.traceId) continue;
      retainedHere = true;
      const canonical = canonicalJson(span);
      const existing = this.retained.get(span.span_id);
      if (existing === undefined) {
        this.retained.set(span.span_id, { span, canonical });
        continue;
      }
      if (existing.canonical !== canonical)
        throw new Error(
          `OpenTelemetry trace contains conflicting records for span ID ${span.span_id}`,
        );
      this.duplicates += 1;
    }
    if (!retainedHere) return;
    this.retainedBytes += bytes;
    if (this.retainedBytes > this.maximumBytes)
      throw new Error(
        `OpenTelemetry correlated trace exceeds the ${this.maximumBytes} byte max_bytes_per_attempt limit: ${this.retainedBytes} bytes retained`,
      );
  }

  private async rescan(end: number): Promise<void> {
    let cursor = this.start;
    while (cursor < end) {
      const limit = Math.min(end, cursor + READ_CHUNK_BYTES);
      const chunk = await Bun.file(this.path).slice(cursor, limit).bytes();
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline < 0)
        throw new Error(
          `OpenTelemetry trace file changed while re-reading bytes ${cursor} to ${end} for the correlated trace`,
        );
      const complete = chunk.subarray(0, lastNewline + 1);
      for (const line of lineSlices(complete))
        this.retain(spansFromLine(decodeLine(line)), line.byteLength + 1);
      cursor += complete.byteLength;
    }
  }
}

function tokenAttribute(span: NormalizedOtlpSpan, key: string): number | undefined {
  const value = span.attributes[key];
  if (value === undefined) return undefined;
  if (!isDecimalInteger(value))
    throw new Error(
      `OpenTelemetry model span ${span.span_id} reports ${key} as ${JSON.stringify(value)}, which is not a non-negative integer`,
    );
  return Number(value);
}

function requiredTokenAttribute(span: NormalizedOtlpSpan, key: string): number {
  const value = tokenAttribute(span, key);
  if (value === undefined)
    throw new Error(
      `OpenTelemetry model span ${span.span_id} (${String(span.attributes[OPERATION_NAME])}) does not report ${key}`,
    );
  return value;
}

interface GenAiMessage {
  role: string;
  parts: Array<Record<string, JsonValue>>;
  finish_reason?: string;
}

function parsedMessages(
  value: JsonValue | undefined,
  attribute: string,
): GenAiMessage[] | undefined {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      throw new Error(`OpenTelemetry ${attribute} is not valid JSON`);
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error(`OpenTelemetry ${attribute} is not a non-empty message array`);
  const messages: GenAiMessage[] = [];
  for (const [index, message] of parsed.entries()) {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      typeof message.role !== "string" ||
      message.role.length === 0 ||
      !Array.isArray(message.parts)
    ) {
      throw new Error(
        `OpenTelemetry ${attribute}[${index}] does not contain a role and parts array`,
      );
    }
    if (
      attribute === OUTPUT_MESSAGES &&
      (typeof message.finish_reason !== "string" || message.finish_reason.length === 0)
    ) {
      throw new Error(`OpenTelemetry ${attribute}[${index}] does not contain a finish_reason`);
    }
    const parts: Array<Record<string, JsonValue>> = [];
    for (const [partIndex, part] of message.parts.entries()) {
      if (
        typeof part !== "object" ||
        part === null ||
        Array.isArray(part) ||
        typeof part.type !== "string" ||
        part.type.length === 0
      ) {
        throw new Error(
          `OpenTelemetry ${attribute}[${index}].parts[${partIndex}] does not contain a type`,
        );
      }
      if (part.type === "text" && typeof part.content !== "string")
        throw new Error(
          `OpenTelemetry ${attribute}[${index}].parts[${partIndex}] does not contain text content`,
        );
      if (part.type === "reasoning" && typeof part.content !== "string")
        throw new Error(
          `OpenTelemetry ${attribute}[${index}].parts[${partIndex}] does not contain reasoning content`,
        );
      if (part.type === "tool_call" && (typeof part.name !== "string" || part.name.length === 0))
        throw new Error(
          `OpenTelemetry ${attribute}[${index}].parts[${partIndex}] does not contain a tool name`,
        );
      if (part.type === "tool_call_response" && !("response" in part))
        throw new Error(
          `OpenTelemetry ${attribute}[${index}].parts[${partIndex}] does not contain a tool response`,
        );
      parts.push(part);
    }
    messages.push({
      role: message.role,
      parts,
      ...(typeof message.finish_reason === "string"
        ? { finish_reason: message.finish_reason }
        : {}),
    });
  }
  return messages;
}

interface ModelSpan {
  span: NormalizedOtlpSpan;
  input?: GenAiMessage[];
  output?: GenAiMessage[];
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
}

function modelSpanView(span: NormalizedOtlpSpan): ModelSpan {
  const inputTokens = requiredTokenAttribute(span, INPUT_TOKENS);
  const outputTokens = requiredTokenAttribute(span, OUTPUT_TOKENS);
  const cacheRead = tokenAttribute(span, CACHE_READ_INPUT_TOKENS);
  const cacheCreation = tokenAttribute(span, CACHE_CREATION_INPUT_TOKENS);
  const reasoning = tokenAttribute(span, REASONING_OUTPUT_TOKENS);
  if (cacheRead !== undefined && cacheRead > inputTokens)
    throw new Error(
      `OpenTelemetry model span ${span.span_id} reports ${CACHE_READ_INPUT_TOKENS} ${cacheRead} above its ${INPUT_TOKENS} total ${inputTokens}`,
    );
  if (cacheCreation !== undefined && cacheCreation > inputTokens)
    throw new Error(
      `OpenTelemetry model span ${span.span_id} reports ${CACHE_CREATION_INPUT_TOKENS} ${cacheCreation} above its ${INPUT_TOKENS} total ${inputTokens}`,
    );
  if (reasoning !== undefined && reasoning > outputTokens)
    throw new Error(
      `OpenTelemetry model span ${span.span_id} reports ${REASONING_OUTPUT_TOKENS} ${reasoning} above its ${OUTPUT_TOKENS} total ${outputTokens}`,
    );
  const input = parsedMessages(span.attributes[INPUT_MESSAGES], INPUT_MESSAGES);
  const output = parsedMessages(span.attributes[OUTPUT_MESSAGES], OUTPUT_MESSAGES);
  return {
    span,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    inputTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function modelSpans(spans: NormalizedOtlpSpan[]): ModelSpan[] {
  return spans
    .filter((span) => {
      const operation = span.attributes[OPERATION_NAME];
      return typeof operation === "string" && MODEL_OPERATIONS.has(operation);
    })
    .map(modelSpanView);
}

function toolCallParts(messages: GenAiMessage[]): number {
  return messages.reduce(
    (total, message) => total + message.parts.filter((part) => part.type === "tool_call").length,
    0,
  );
}

function observedUsage(models: ModelSpan[]): {
  usage: GenAiUsage;
  coverage: OtlpTraceEvidence["usage_attribute_coverage"];
} {
  const coverage = {
    output_messages_for_tool_calls: models.filter((model) => model.output !== undefined).length,
    cache_read_input_tokens: models.filter((model) => model.cacheRead !== undefined).length,
    cache_creation_input_tokens: models.filter((model) => model.cacheCreation !== undefined).length,
    reasoning_output_tokens: models.filter((model) => model.reasoning !== undefined).length,
  };
  const complete = (covered: number): boolean => covered === models.length && models.length > 0;
  const sum = (select: (model: ModelSpan) => number | undefined): number =>
    models.reduce((total, model) => total + (select(model) ?? 0), 0);
  return {
    coverage,
    usage: {
      modelCalls: models.length,
      inputTokens: sum((model) => model.inputTokens),
      outputTokens: sum((model) => model.outputTokens),
      ...(complete(coverage.output_messages_for_tool_calls)
        ? { toolCalls: sum((model) => (model.output ? toolCallParts(model.output) : 0)) }
        : {}),
      ...(complete(coverage.cache_read_input_tokens)
        ? { cacheReadInputTokens: sum((model) => model.cacheRead) }
        : {}),
      ...(complete(coverage.cache_creation_input_tokens)
        ? { cacheCreationInputTokens: sum((model) => model.cacheCreation) }
        : {}),
      ...(complete(coverage.reasoning_output_tokens)
        ? { reasoningOutputTokens: sum((model) => model.reasoning) }
        : {}),
    },
  };
}

const OPTIONAL_USAGE_FIELDS = [
  ["tool_calls", "toolCalls", "output_messages_for_tool_calls"],
  ["cache_read_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"],
  ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
  ["reasoning_output_tokens", "reasoningOutputTokens", "reasoning_output_tokens"],
] as const;

function verifyUsage(
  observed: GenAiUsage,
  expected: GenAiUsage,
  coverage: OtlpTraceEvidence["usage_attribute_coverage"],
  modelSpanCount: number,
): OtlpTraceEvidence["usage_reconciliation_fields"] {
  const compared: string[] = [];
  const notObservable: string[] = [];
  const disagreements: string[] = [];
  const compare = (field: string, left: number | undefined, right: number): void => {
    compared.push(field);
    if (left !== right) disagreements.push(field);
  };
  compare("model_calls", observed.modelCalls, expected.modelCalls);
  compare("input_tokens", observed.inputTokens, expected.inputTokens);
  compare("output_tokens", observed.outputTokens, expected.outputTokens);
  for (const [field, key, coverageKey] of OPTIONAL_USAGE_FIELDS) {
    const wanted = expected[key];
    if (wanted === undefined) continue;
    if (modelSpanCount > 0 && coverage[coverageKey] === modelSpanCount)
      compare(field, observed[key], wanted);
    else notObservable.push(field);
  }
  if (disagreements.length > 0) {
    throw new Error(
      `OpenTelemetry usage disagrees with product accounting on ${disagreements.join(", ")}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
    );
  }
  return { compared, not_observable: notObservable };
}

function verifyProviderIds(observed: string[], expected: string[]): void {
  const actual = [...observed].sort();
  const wanted = [...expected].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `OpenTelemetry provider request IDs disagree with product accounting: expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(actual)}`,
    );
  }
}

function unmappedFinishReasons(models: ModelSpan[]): string[] {
  const unmapped = new Set<string>();
  for (const model of models)
    for (const message of model.output ?? [])
      if (message.finish_reason !== undefined && !FINISH_REASONS.has(message.finish_reason))
        unmapped.add(message.finish_reason);
  return [...unmapped].sort();
}

function outputContentInventory(
  models: ModelSpan[],
): OtlpTraceEvidence["output_content_inventory"] {
  const inventory = {
    text_parts: 0,
    reasoning_parts: 0,
    reasoning_characters: 0,
    tool_call_parts: 0,
    other_parts: 0,
  };
  for (const model of models) {
    for (const message of model.output ?? []) {
      for (const part of message.parts) {
        if (part.type === "text") inventory.text_parts += 1;
        else if (part.type === "reasoning") {
          inventory.reasoning_parts += 1;
          inventory.reasoning_characters += String(part.content).length;
        } else if (part.type === "tool_call") inventory.tool_call_parts += 1;
        else inventory.other_parts += 1;
      }
    }
  }
  return inventory;
}

function assertCompleteTrace(
  spans: NormalizedOtlpSpan[],
  duplicates: number,
): Omit<OtlpTraceEvidence["completeness"], "stable_poll_count"> {
  const ids = new Set(spans.map((span) => span.span_id));
  const orphans = spans.filter(
    (span) => span.parent_span_id !== undefined && !ids.has(span.parent_span_id),
  );
  const droppedAttributes = spans.reduce(
    (total, span) =>
      total +
      span.dropped_attributes_count +
      span.events.reduce((events, event) => events + event.dropped_attributes_count, 0) +
      span.links.reduce((links, link) => links + link.dropped_attributes_count, 0),
    0,
  );
  const droppedEvents = spans.reduce((total, span) => total + span.dropped_events_count, 0);
  const droppedLinks = spans.reduce((total, span) => total + span.dropped_links_count, 0);
  if (orphans.length > 0)
    throw new Error(
      `OpenTelemetry trace is incomplete: ${orphans.length} of ${spans.length} spans reference a parent that was not exported`,
    );
  if (droppedAttributes + droppedEvents + droppedLinks > 0)
    throw new Error(
      `OpenTelemetry trace reports dropped telemetry: ${droppedAttributes} attributes, ${droppedEvents} events, ${droppedLinks} links`,
    );
  return {
    duplicate_span_ids: duplicates,
    orphan_span_count: orphans.length,
    dropped_attributes: droppedAttributes,
    dropped_events: droppedEvents,
    dropped_links: droppedLinks,
  };
}

function contentSpans(spans: NormalizedOtlpSpan[]): NormalizedOtlpSpan[] {
  return spans.filter((span) =>
    CONTENT_ATTRIBUTES.some((attribute) => span.attributes[attribute] !== undefined),
  );
}

function metadataOnlySpan(
  span: NormalizedOtlpSpan,
  correlationAttribute: string,
): NormalizedOtlpSpan {
  const attributes = Object.fromEntries(
    Object.entries(span.attributes).filter(
      ([name]) => name === correlationAttribute || SAFE_METADATA_ATTRIBUTES.has(name),
    ),
  );
  const operation = attributes[OPERATION_NAME];
  if (typeof operation !== "string" || !MODEL_OPERATIONS.has(operation)) {
    delete attributes[OPERATION_NAME];
  }
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    ...(span.parent_span_id === undefined ? {} : { parent_span_id: span.parent_span_id }),
    ...(span.flags === undefined ? {} : { flags: span.flags }),
    name:
      typeof operation === "string" && MODEL_OPERATIONS.has(operation)
        ? `gen_ai.${operation}`
        : "span",
    ...(span.kind === undefined ? {} : { kind: span.kind }),
    start_time_unix_nano: span.start_time_unix_nano,
    end_time_unix_nano: span.end_time_unix_nano,
    resource_attributes: {},
    attributes,
    dropped_attributes_count: span.dropped_attributes_count,
    events: [],
    dropped_events_count: span.dropped_events_count,
    links: span.links.map((link) => ({
      trace_id: link.trace_id,
      span_id: link.span_id,
      ...(link.flags === undefined ? {} : { flags: link.flags }),
      attributes: {},
      dropped_attributes_count: link.dropped_attributes_count,
    })),
    dropped_links_count: span.dropped_links_count,
  };
}

export async function captureOtlpTrace(
  options: CaptureOtlpTraceOptions,
): Promise<OtlpTraceEvidence> {
  const deadline = Date.now() + options.timeoutMs;
  const requiredStablePolls = options.stablePollCount ?? 2;
  const scan = new OtlpFileScan(
    options.path,
    options.cursor,
    options.maximumBytes,
    options.correlation,
  );
  const assemble = (traceId: string, stablePolls: number): OtlpTraceEvidence => {
    const spans = scan.spans();
    const completeness = assertCompleteTrace(spans, scan.duplicateSpanIds);
    const models = modelSpans(spans);
    const { usage, coverage } = observedUsage(models);
    const reconciliation = options.expectedUsage
      ? verifyUsage(usage, options.expectedUsage, coverage, models.length)
      : undefined;
    const providerIds = models
      .map((model) => model.span.attributes[RESPONSE_ID])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (options.expectedProviderRequestIds)
      verifyProviderIds(providerIds, options.expectedProviderRequestIds);
    const withContent = contentSpans(spans);
    if (options.contentPolicy === "forbidden" && withContent.length > 0) {
      const attributes = [
        ...new Set(
          withContent.flatMap((span) =>
            CONTENT_ATTRIBUTES.filter((attribute) => span.attributes[attribute] !== undefined),
          ),
        ),
      ];
      throw new Error(
        `OpenTelemetry content capture is forbidden but ${withContent.length} of ${spans.length} spans carry content attributes (${attributes.join(", ")})`,
      );
    }
    const messageSpans = models.filter(
      (model) => model.input !== undefined && model.output !== undefined,
    ).length;
    if (options.contentPolicy === "required" && models.length === 0)
      throw new Error(
        `OpenTelemetry content capture requires at least one model span, observed 0 of ${spans.length} spans with a ${OPERATION_NAME} inference operation`,
      );
    if (options.contentPolicy === "required" && messageSpans !== models.length)
      throw new Error(
        `OpenTelemetry content capture is incomplete: ${messageSpans} of ${models.length} model spans contain standard input and output messages`,
      );
    return {
      profile: "exgen.otel.genai.v3",
      source: options.source,
      source_segment: {
        byte_start: options.cursor,
        byte_end: scan.byteEnd,
        sha256: scan.sha256,
      },
      correlation: options.correlation,
      trace_id: traceId,
      correlated_span_ids: scan.correlatedSpanIds,
      span_count: spans.length,
      model_span_count: models.length,
      usage_reconciliation:
        reconciliation === undefined
          ? "not_requested"
          : reconciliation.not_observable.length > 0
            ? "partially_observable"
            : "verified",
      usage_reconciliation_fields: reconciliation ?? { compared: [], not_observable: [] },
      provider_request_id_reconciliation: options.expectedProviderRequestIds
        ? "verified"
        : "not_requested",
      observed_usage: usage,
      usage_attribute_coverage: coverage,
      observed_provider_request_ids: providerIds,
      completeness: { ...completeness, stable_poll_count: stablePolls },
      content_capture: withContent.length > 0 ? "content_present" : "metadata_only",
      content_span_count: withContent.length,
      model_message_span_count: messageSpans,
      unmapped_finish_reasons: unmappedFinishReasons(models),
      output_content_inventory: outputContentInventory(models),
      spans:
        options.contentPolicy === "forbidden"
          ? spans.map((span) => metadataOnlySpan(span, options.correlation.attribute))
          : spans,
    };
  };
  const expectationMet = (): boolean => {
    if (!options.expectedUsage) return true;
    try {
      const models = modelSpans(scan.spans());
      const { usage, coverage } = observedUsage(models);
      verifyUsage(usage, options.expectedUsage, coverage, models.length);
      return true;
    } catch {
      return false;
    }
  };
  let previousIdentity = "";
  let stablePolls = 0;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    await scan.poll();
    const traceId = scan.correlatedTraceId;
    if (traceId !== undefined) {
      const identity = scan
        .spans()
        .map((span) => span.span_id)
        .join(",");
      const settled = identity === previousIdentity && expectationMet();
      stablePolls = settled ? stablePolls + 1 : 0;
      previousIdentity = identity;
      if (stablePolls >= requiredStablePolls) return assemble(traceId, stablePolls);
    }
    if (Date.now() >= deadline) {
      if (traceId !== undefined) assemble(traceId, stablePolls);
      throw new Error(
        `OpenTelemetry trace for correlation ${options.correlation.value} was not exported completely within ${options.timeoutMs} ms: ${stablePolls} of ${requiredStablePolls} stable polls`,
      );
    }
    await sleep(Math.min(options.pollIntervalMs, deadline - Date.now()), undefined, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

export async function waitForOtlpExport(
  options: WaitForOtlpExportOptions,
): Promise<OtlpPreflightResult> {
  const deadline = Date.now() + options.timeoutMs;
  const scan = new OtlpFileScan(options.path, options.cursor, options.maximumBytes);
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    await scan.poll();
    if (scan.decodedModelSpanCount > 0)
      return {
        exported_spans: scan.scannedSpanCount,
        decoded_model_spans: scan.decodedModelSpanCount,
        verified: "model_span_decoded",
      };
    if (Date.now() >= deadline) {
      if (scan.scannedSpanCount === 0)
        throw new Error("The system under test did not export OpenTelemetry data during preflight");
      return {
        exported_spans: scan.scannedSpanCount,
        decoded_model_spans: 0,
        verified: "delivery_only",
      };
    }
    await sleep(Math.min(options.pollIntervalMs, deadline - Date.now()), undefined, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}
