import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { artemisParametersSchema } from "../adapters/artemis/config.ts";
import {
  captureTelemetry,
  CONTENT_COMPLETE_ATTRIBUTE,
  type TelemetryUsage,
  telemetryCursor,
  waitForTelemetryExport,
} from "../adapters/artemis/opentelemetry.ts";
import { captureOtlpTrace, type OtlpTraceEvidence } from "../src/telemetry/opentelemetry.ts";
import {
  ABSENT_PARENT_SPAN_ID,
  batch,
  boundedModelSpan,
  json,
  MODEL_SPAN_ID,
  modelSpan,
  OTHER_TRACE_ID,
  ROOT_SPAN_ID,
  rootSpan,
  START_TIME_UNIX_NANO,
  span,
  TRACE_ID,
  text,
  trace,
  truncatedModelSpan,
} from "./fixtures/otlp.ts";

const directories: string[] = [];
const EVIDENCE_PATH = "telemetry/opentelemetry-trace.json";
let previousTracePath: string | undefined;
let tracePathWasSet = false;

afterEach(async () => {
  if (tracePathWasSet) {
    if (previousTracePath === undefined) delete process.env.ARTEMIS_TEST_OTEL_PATH;
    else process.env.ARTEMIS_TEST_OTEL_PATH = previousTracePath;
    tracePathWasSet = false;
    previousTracePath = undefined;
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(telemetry: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "exgen-artemis-otel-"));
  directories.push(directory);
  const traces = join(directory, "traces.jsonl");
  const output = join(directory, "output");
  await mkdir(output);
  await writeFile(traces, "");
  if (!tracePathWasSet) {
    previousTracePath = process.env.ARTEMIS_TEST_OTEL_PATH;
    tracePathWasSet = true;
  }
  process.env.ARTEMIS_TEST_OTEL_PATH = traces;
  const parameters = artemisParametersSchema.parse({
    base_url: "http://127.0.0.1:8080",
    auth: { type: "none" },
    course_id: 1,
    telemetry: {
      provider: "opentelemetry",
      traces_path_env: "ARTEMIS_TEST_OTEL_PATH",
      artemis_otlp_endpoint: "http://127.0.0.1:4318/v1/traces",
      content_capture: "required",
      timeout_ms: 1_000,
      poll_interval_ms: 1,
      verify_usage: true,
      ...telemetry,
    },
  });
  return { directory, traces, output, parameters };
}

const DEFAULT_USAGE: TelemetryUsage = {
  modelCalls: 1,
  toolCalls: 1,
  inputTokens: 100,
  outputTokens: 20,
  providerRequestIds: ["request-1"],
};

async function capture(
  parameters: Awaited<ReturnType<typeof fixture>>["parameters"],
  output: string,
  usage: TelemetryUsage = DEFAULT_USAGE,
  cursor = 0,
) {
  return await captureTelemetry(
    parameters,
    cursor,
    "job-1",
    usage,
    output,
    new AbortController().signal,
  );
}

async function boundedCapture(records: string): Promise<OtlpTraceEvidence> {
  const { traces } = await fixture();
  await writeFile(traces, records);
  return await captureOtlpTrace({
    path: traces,
    source: "opentelemetry-collector-file-exporter",
    cursor: 0,
    maximumBytes: 1_000_000,
    timeoutMs: 300,
    pollIntervalMs: 5,
    correlation: { attribute: "artemis.hyperion.job.id", value: "job-1" },
    contentPolicy: "bounded",
    contentBoundaryAttribute: CONTENT_COMPLETE_ATTRIBUTE,
  });
}

async function evidenceOf(output: string): Promise<OtlpTraceEvidence> {
  return (await Bun.file(join(output, EVIDENCE_PATH)).json()) as OtlpTraceEvidence;
}

describe("Artemis OpenTelemetry evidence", () => {
  test("captures the exact job trace and verifies GenAI usage", async () => {
    const { traces, output, parameters } = await fixture();
    const cursor = await telemetryCursor(parameters);
    await writeFile(traces, trace());

    const captured = await capture(parameters, output, DEFAULT_USAGE, cursor);

    expect(captured).toMatchObject({
      traceId: TRACE_ID,
      spanCount: 2,
      modelSpanCount: 1,
      diagnostic: { kind: "trace", visibility: "restricted" },
    });
    const written = await Bun.file(join(output, EVIDENCE_PATH)).bytes();
    expect(captured?.diagnostic.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(written).digest("hex"),
    );
    expect(captured?.diagnostic.size_bytes).toBe(written.byteLength);
    const evidence = await evidenceOf(output);
    expect(evidence.profile).toBe("exgen.otel.genai.v4");
    expect(evidence.source).toBe("opentelemetry-collector-file-exporter");
    expect(evidence.trace_id).toBe(TRACE_ID);
    expect(evidence.correlated_span_ids).toEqual([ROOT_SPAN_ID]);
    expect(evidence.correlation).toEqual({
      attribute: "artemis.hyperion.job.id",
      value: "job-1",
    });
    expect(evidence.usage_reconciliation).toBe("verified");
    expect(evidence.provider_request_id_reconciliation).toBe("verified");
    expect(evidence.span_count).toBe(2);
    expect(evidence.content_capture).toBe("content_present");
    expect(evidence.content_span_count).toBe(1);
    expect(evidence.model_message_span_count).toBe(1);
    expect(evidence.output_content_inventory).toEqual({
      text_parts: 1,
      reasoning_parts: 1,
      reasoning_characters: 24,
      tool_call_parts: 1,
      other_parts: 0,
    });
    expect(evidence.observed_usage).toEqual({
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(evidence.usage_attribute_coverage).toEqual({
      output_messages_for_tool_calls: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
    });
    const model = evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID);
    expect(model).toMatchObject({ kind: 3, flags: 259, status: { code: 1 } });
    expect(model?.start_time_unix_nano).toBe("1785534511734643676");
    expect(JSON.parse(String(model?.attributes["gen_ai.output.messages"]))[0]).toMatchObject({
      finish_reason: "tool_call",
    });
    expect(evidence.completeness).toMatchObject({
      duplicate_span_ids: 0,
      orphan_span_count: 0,
      dropped_attributes: 0,
      dropped_events: 0,
      dropped_links: 0,
    });
    expect(evidence.completeness.stable_poll_count).toBeGreaterThanOrEqual(2);
  });

  test("retains schema URLs and instrumentation scope identity in the normalized trace", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(traces, trace());

    await capture(parameters, output);

    const evidence = await evidenceOf(output);
    expect(evidence.spans[0]).toMatchObject({
      resource_schema_url: "https://opentelemetry.io/schemas/1.37.0",
      instrumentation_scope_schema_url: "https://opentelemetry.io/schemas/1.37.0",
      instrumentation_scope: { name: "org.springframework.ai.chat.observation", version: "1.1.0" },
    });
  });

  test("attests only complete records when the file ends with a torn line", async () => {
    const { traces, output, parameters } = await fixture();
    const complete = batch(
      rootSpan({ attributes: { "artemis.brief": text("Prüfungsaufgabe — 图论 🎓") } }),
      modelSpan(),
    );
    await writeFile(traces, `${complete}{"resourceSpans":[{"scopeSpans"`);

    await capture(parameters, output);

    const evidence = await evidenceOf(output);
    expect(evidence.span_count).toBe(2);
    expect(evidence.source_segment.byte_end).toBe(Buffer.byteLength(complete, "utf8"));
    expect(evidence.source_segment.byte_end).toBeGreaterThan(complete.length);
    const attested = await Bun.file(traces)
      .slice(evidence.source_segment.byte_start, evidence.source_segment.byte_end)
      .bytes();
    expect(evidence.source_segment.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(attested).digest("hex"),
    );
  });

  test("fails closed when trace usage disagrees with product accounting", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, trace({ tokens: { input: 100, output: 19 } }));

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry usage disagrees with product accounting on output_tokens",
    );
  });

  test("fails closed when the trace reports a different number of model calls", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(
      traces,
      batch(
        rootSpan(),
        modelSpan({ tokens: { input: 50, output: 10 } }),
        modelSpan({
          spanId: "f".repeat(16),
          responseId: "request-2",
          tokens: { input: 50, output: 10 },
        }),
      ),
    );

    await expect(
      capture(parameters, output, {
        modelCalls: 1,
        toolCalls: 2,
        inputTokens: 100,
        outputTokens: 20,
        providerRequestIds: ["request-1", "request-2"],
      }),
    ).rejects.toThrow("OpenTelemetry usage disagrees with product accounting on model_calls");
  });

  test("classifies an expected value the trace cannot observe as not observable", async () => {
    const observable = await fixture();
    await writeFile(
      observable.traces,
      trace({ tokens: { input: 100, output: 20, cacheRead: 10, reasoning: 5 } }),
    );
    await capture(observable.parameters, observable.output, {
      ...DEFAULT_USAGE,
      cacheReadInputTokens: 10,
      reasoningOutputTokens: 5,
    });
    const verified = await evidenceOf(observable.output);
    expect(verified.usage_reconciliation).toBe("verified");
    expect(verified.usage_reconciliation_fields.compared).toContain("cache_read_input_tokens");
    expect(verified.usage_reconciliation_fields.not_observable).toEqual([]);

    const disagreeing = await fixture({ timeout_ms: 300 });
    await writeFile(
      disagreeing.traces,
      trace({ tokens: { input: 100, output: 20, cacheRead: 10 } }),
    );
    await expect(
      capture(disagreeing.parameters, disagreeing.output, {
        ...DEFAULT_USAGE,
        cacheReadInputTokens: 9,
      }),
    ).rejects.toThrow(
      "OpenTelemetry usage disagrees with product accounting on cache_read_input_tokens",
    );

    const unobservable = await fixture();
    await writeFile(unobservable.traces, trace());
    await capture(unobservable.parameters, unobservable.output, {
      ...DEFAULT_USAGE,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 40,
    });
    const classified = await evidenceOf(unobservable.output);
    expect(classified.usage_reconciliation).toBe("partially_observable");
    expect(classified.usage_reconciliation_fields.not_observable).toEqual([
      "cache_read_input_tokens",
      "reasoning_output_tokens",
    ]);
    expect(classified.observed_usage).not.toHaveProperty("cacheReadInputTokens");

    const partial = await fixture();
    await writeFile(
      partial.traces,
      batch(
        rootSpan(),
        modelSpan({ tokens: { input: 50, output: 10, cacheRead: 5 } }),
        modelSpan({
          spanId: "f".repeat(16),
          responseId: "request-2",
          tokens: { input: 50, output: 10 },
        }),
      ),
    );
    await capture(partial.parameters, partial.output, {
      modelCalls: 2,
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      providerRequestIds: ["request-1", "request-2"],
    });
    const partialEvidence = await evidenceOf(partial.output);
    expect(partialEvidence.usage_reconciliation).toBe("partially_observable");
    expect(partialEvidence.usage_reconciliation_fields.not_observable).toEqual([
      "cache_read_input_tokens",
    ]);
    expect(partialEvidence.usage_attribute_coverage.cache_read_input_tokens).toBe(1);
    expect(partialEvidence.observed_usage).not.toHaveProperty("cacheReadInputTokens");
  });

  test("waits for a trace that grows across polls before attesting it", async () => {
    const { traces, output, parameters } = await fixture({
      timeout_ms: 5_000,
      poll_interval_ms: 20,
    });
    await writeFile(traces, batch(rootSpan()));
    const pending = capture(parameters, output);
    await sleep(120);
    await appendFile(traces, batch(modelSpan()));

    const captured = await pending;

    expect(captured).toMatchObject({ spanCount: 2, modelSpanCount: 1 });
    const evidence = await evidenceOf(output);
    expect(evidence.completeness.stable_poll_count).toBeGreaterThanOrEqual(2);
  });

  test("retains spans exported before the correlated root span", async () => {
    const { traces, output, parameters } = await fixture({
      timeout_ms: 5_000,
      poll_interval_ms: 20,
    });
    await writeFile(traces, batch(modelSpan()));
    const pending = capture(parameters, output);
    await sleep(120);
    await appendFile(traces, batch(rootSpan()));

    const captured = await pending;

    expect(captured).toMatchObject({ spanCount: 2, modelSpanCount: 1 });
  });

  test("collapses a byte-identical retry duplicate and rejects a conflicting one", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(traces, `${trace()}${trace()}`);

    await capture(parameters, output);

    const evidence = await evidenceOf(output);
    expect(evidence.span_count).toBe(2);
    expect(evidence.completeness.duplicate_span_ids).toBe(2);

    const conflicting = await fixture({ timeout_ms: 300 });
    await writeFile(
      conflicting.traces,
      `${trace()}${batch(modelSpan({ responseId: "request-2" }))}`,
    );
    await expect(capture(conflicting.parameters, conflicting.output)).rejects.toThrow(
      `OpenTelemetry trace contains conflicting records for span ID ${MODEL_SPAN_ID}`,
    );
  });

  test("treats an all-zero parent span ID as a root but rejects a genuine orphan", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(
      traces,
      batch(
        rootSpan({ parentSpanId: ABSENT_PARENT_SPAN_ID }),
        modelSpan(),
        span({ spanId: "e".repeat(16), name: "second root", parentSpanId: ABSENT_PARENT_SPAN_ID }),
      ),
    );

    await capture(parameters, output);

    const evidence = await evidenceOf(output);
    expect(evidence.span_count).toBe(3);

    const orphaned = await fixture({ timeout_ms: 300 });
    await writeFile(
      orphaned.traces,
      batch(rootSpan({ parentSpanId: "c".repeat(16) }), modelSpan()),
    );
    await expect(capture(orphaned.parameters, orphaned.output)).rejects.toThrow(
      "OpenTelemetry trace is incomplete: 1 of 2 spans reference a parent that was not exported",
    );
  });

  test("normalizes every conforming integer encoding to identical evidence", async () => {
    const tokens = { input: 996, output: 1_496 };
    const usage = {
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 996,
      outputTokens: 1_496,
      providerRequestIds: ["request-1"],
    };
    const encodings = ["string", "intString", "intNumber"] as const;
    const normalized: string[] = [];
    for (const tokenEncoding of encodings) {
      const { traces, output, parameters } = await fixture();
      await writeFile(
        traces,
        batch(rootSpan(), modelSpan({ tokens, tokenEncoding, startTimeUnixNano: 1_496 })),
      );

      await capture(parameters, output, usage);

      const evidence = await evidenceOf(output);
      const model = evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID);
      expect(model?.attributes["gen_ai.usage.input_tokens"]).toBe(996);
      expect(model?.start_time_unix_nano).toBe("1496");
      expect(evidence.observed_usage.inputTokens).toBe(996);
      normalized.push(
        JSON.stringify({ spans: evidence.spans, observed_usage: evidence.observed_usage }),
      );
    }

    expect(normalized[1]).toBe(normalized[0]);
    expect(normalized[2]).toBe(normalized[0]);
  });

  test("rejects a 64-bit value sent as a JSON number it cannot carry exactly", async () => {
    const lossy = await fixture({ timeout_ms: 200 });
    // Unquoted on the wire, never as a TypeScript literal: the source literal would already be
    // rounded, so the rounding has to happen where a real producer's does, inside JSON.parse.
    await writeFile(
      lossy.traces,
      batch(rootSpan(), modelSpan({ startTimeUnixNano: START_TIME_UNIX_NANO })).replaceAll(
        `"startTimeUnixNano":"${START_TIME_UNIX_NANO}"`,
        `"startTimeUnixNano":${START_TIME_UNIX_NANO}`,
      ),
    );

    await expect(capture(lossy.parameters, lossy.output)).rejects.toThrow(
      "above the 9007199254740991 exact-integer limit of JSON numbers",
    );

    const lossless = await fixture();
    await writeFile(
      lossless.traces,
      batch(rootSpan(), modelSpan({ startTimeUnixNano: START_TIME_UNIX_NANO })),
    );

    await capture(lossless.parameters, lossless.output);

    const evidence = await evidenceOf(lossless.output);
    expect(
      evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID)?.start_time_unix_nano,
    ).toBe(START_TIME_UNIX_NANO);
  });

  test("rejects a token count that is not a decimal integer", async () => {
    for (const invalid of ["12a", "-1", "1.5", "007"]) {
      const { traces, output, parameters } = await fixture({ timeout_ms: 200 });
      await writeFile(
        traces,
        batch(rootSpan(), modelSpan({ tokens: { input: text(invalid), output: 20 } })),
      );

      await expect(capture(parameters, output)).rejects.toThrow(
        `reports gen_ai.usage.input_tokens as ${JSON.stringify(invalid)}, which is not a non-negative integer`,
      );
    }
  });

  test("rejects a truncated or replaced trace file", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, trace());
    const cursor = await telemetryCursor(parameters);
    await writeFile(traces, "{}\n");

    await expect(capture(parameters, output, DEFAULT_USAGE, cursor)).rejects.toThrow(
      "OpenTelemetry trace file was truncated during the attempt",
    );

    const rotated = await fixture({ timeout_ms: 5_000, poll_interval_ms: 60 });
    await writeFile(rotated.traces, batch(rootSpan()));
    const pending = capture(rotated.parameters, rotated.output);
    await sleep(20);
    const replacement = `${rotated.traces}.1`;
    await writeFile(replacement, `${batch(rootSpan())}${batch(modelSpan())}`);
    await rename(replacement, rotated.traces);

    await expect(pending).rejects.toThrow(
      "OpenTelemetry trace file was replaced during the attempt",
    );
  });

  test("rescans a correlated trace from a stable prefix while the exporter appends", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 2_000 });
    await writeFile(traces, batch(modelSpan()));

    const appending = (async () => {
      for (let index = 0; index < 100; index++) {
        await appendFile(
          traces,
          batch(
            rootSpan({
              traceId: OTHER_TRACE_ID,
              spanId: index.toString(16).padStart(16, "0"),
              attributes: { "artemis.hyperion.job.id": text("other-job") },
            }),
          ),
        );
        await sleep(1);
      }
    })();
    await appendFile(traces, batch(rootSpan()));

    const captured = await capture(parameters, output);
    await appending;

    expect(captured).toMatchObject({ traceId: TRACE_ID, spanCount: 2, modelSpanCount: 1 });
  });

  test("starts at the last complete record when the exporter is mid-write", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 2_000 });
    const existing = batch(modelSpan()).trimEnd();
    await writeFile(traces, existing);

    const cursor = await telemetryCursor(parameters);
    expect(cursor).toBe(0);
    await appendFile(traces, `\n${batch(rootSpan())}`);

    const captured = await capture(parameters, output, DEFAULT_USAGE, cursor);

    expect(captured).toMatchObject({ traceId: TRACE_ID, spanCount: 2, modelSpanCount: 1 });
  });

  test("rejects a correlated trace larger than max_bytes_per_attempt", async () => {
    const { traces, output, parameters } = await fixture({
      max_bytes_per_attempt: 2_048,
      timeout_ms: 300,
    });
    await writeFile(
      traces,
      batch(rootSpan({ attributes: { "artemis.brief": text("x".repeat(4_096)) } }), modelSpan()),
    );

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry correlated trace exceeds the 2048 byte max_bytes_per_attempt limit",
    );
  });

  test("rejects two traces carrying the same correlation value", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(
      traces,
      `${trace()}${batch(rootSpan({ traceId: OTHER_TRACE_ID, spanId: "d".repeat(16) }))}`,
    );

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry exported multiple traces for correlation job-1",
    );
  });

  test("rejects a span that reports dropped attributes", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, batch(rootSpan(), modelSpan({ droppedAttributesCount: 2 })));

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry trace reports dropped telemetry: 2 attributes, 0 events, 0 links",
    );
  });

  test("publishes an optional token aggregate only when every model span reports it", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(
      traces,
      batch(
        rootSpan(),
        modelSpan({ tokens: { input: 100, output: 20, cacheRead: 10 } }),
        modelSpan({
          spanId: "f".repeat(16),
          responseId: "request-2",
          tokens: { input: 50, output: 5 },
        }),
      ),
    );

    await capture(parameters, output, {
      modelCalls: 2,
      toolCalls: 2,
      inputTokens: 150,
      outputTokens: 25,
      providerRequestIds: ["request-1", "request-2"],
    });

    const evidence = await evidenceOf(output);
    expect(evidence.observed_usage).not.toHaveProperty("cacheReadInputTokens");
    expect(evidence.usage_attribute_coverage.cache_read_input_tokens).toBe(1);
    expect(evidence.usage_attribute_coverage.reasoning_output_tokens).toBe(0);

    const complete = await fixture();
    await writeFile(
      complete.traces,
      batch(
        rootSpan(),
        modelSpan({ tokens: { input: 100, output: 20, cacheRead: 10, reasoning: 4 } }),
        modelSpan({
          spanId: "f".repeat(16),
          responseId: "request-2",
          tokens: { input: 50, output: 5, cacheRead: 2, reasoning: 1 },
        }),
      ),
    );

    await capture(complete.parameters, complete.output, {
      modelCalls: 2,
      toolCalls: 2,
      inputTokens: 150,
      outputTokens: 25,
      cacheReadInputTokens: 12,
      reasoningOutputTokens: 5,
      providerRequestIds: ["request-1", "request-2"],
    });

    const aggregated = await evidenceOf(complete.output);
    expect(aggregated.observed_usage).toMatchObject({
      cacheReadInputTokens: 12,
      reasoningOutputTokens: 5,
    });
    expect(aggregated.observed_usage).not.toHaveProperty("cacheCreationInputTokens");
  });

  test("rejects token detail that exceeds its inclusive total", async () => {
    const cached = await fixture({ timeout_ms: 300 });
    await writeFile(cached.traces, trace({ tokens: { input: 100, output: 20, cacheRead: 200 } }));
    await expect(capture(cached.parameters, cached.output)).rejects.toThrow(
      "reports gen_ai.usage.cache_read.input_tokens 200 above its gen_ai.usage.input_tokens total 100",
    );

    const reasoning = await fixture({ timeout_ms: 300 });
    await writeFile(reasoning.traces, trace({ tokens: { input: 100, output: 20, reasoning: 25 } }));
    await expect(capture(reasoning.parameters, reasoning.output)).rejects.toThrow(
      "reports gen_ai.usage.reasoning.output_tokens 25 above its gen_ai.usage.output_tokens total 20",
    );
  });

  test("rejects a malformed export record", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, `${trace()}{"resourceSpans": [\n`);

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry file exporter emitted invalid JSON",
    );
  });

  test("rejects invalid identifier hex and lowercases valid uppercase hex", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, batch(rootSpan({ traceId: "not-hex" })));

    await expect(capture(parameters, output)).rejects.toThrow(
      "OpenTelemetry export has an invalid traceId",
    );

    const uppercase = await fixture();
    await writeFile(
      uppercase.traces,
      batch(
        rootSpan({ traceId: "A".repeat(32), spanId: "B".repeat(16) }),
        modelSpan({
          traceId: "A".repeat(32),
          spanId: "C".repeat(16),
          parentSpanId: "B".repeat(16),
        }),
      ),
    );

    const captured = await capture(uppercase.parameters, uppercase.output);

    expect(captured?.traceId).toBe("a".repeat(32));
    const evidence = await evidenceOf(uppercase.output);
    expect(evidence.correlated_span_ids).toEqual(["b".repeat(16)]);
  });

  test("preflight decodes an exported model span after its cursor", async () => {
    const { traces, parameters } = await fixture();
    const cursor = await telemetryCursor(parameters);
    setTimeout(() => void writeFile(traces, trace()), 5);

    await expect(waitForTelemetryExport(parameters, cursor)).resolves.toEqual({
      exported_spans: 2,
      decoded_model_spans: 1,
      verified: "model_span_decoded",
    });
  });

  test("preflight reports delivery without decoding when no model span is exported", async () => {
    const { traces, parameters } = await fixture({ timeout_ms: 200 });
    await writeFile(traces, batch(rootSpan()));

    await expect(waitForTelemetryExport(parameters, 0)).resolves.toEqual({
      exported_spans: 1,
      decoded_model_spans: 0,
      verified: "delivery_only",
    });
  });

  test("preflight fails when an exported model span cannot be decoded", async () => {
    const stringly = await fixture({ timeout_ms: 200 });
    await writeFile(stringly.traces, batch(rootSpan(), modelSpan({ tokens: {} })));
    await expect(waitForTelemetryExport(stringly.parameters, 0)).rejects.toThrow(
      "does not report gen_ai.usage.input_tokens",
    );

    const malformed = await fixture({ timeout_ms: 200 });
    await writeFile(
      malformed.traces,
      batch(rootSpan(), modelSpan({ tokens: { input: text("12a"), output: 20 } })),
    );
    await expect(waitForTelemetryExport(malformed.parameters, 0)).rejects.toThrow(
      'reports gen_ai.usage.input_tokens as "12a", which is not a non-negative integer',
    );
  });

  test("preflight stops when its abort signal fires", async () => {
    const { parameters } = await fixture({ timeout_ms: 5_000 });
    const controller = new AbortController();
    controller.abort(new Error("attempt was cancelled"));

    await expect(waitForTelemetryExport(parameters, 0, controller.signal)).rejects.toThrow(
      "attempt was cancelled",
    );
  });

  test("fails closed when provider request identities disagree", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, trace());

    await expect(
      capture(parameters, output, { ...DEFAULT_USAGE, providerRequestIds: ["different-request"] }),
    ).rejects.toThrow("provider request IDs disagree");
  });

  test("verifies provider identities even when usage reconciliation is disabled", async () => {
    const { traces, output, parameters } = await fixture({ verify_usage: false });
    await writeFile(traces, trace());

    await expect(
      capture(parameters, output, {
        modelCalls: 999,
        inputTokens: 999,
        outputTokens: 999,
        providerRequestIds: ["different-request"],
      }),
    ).rejects.toThrow("provider request IDs disagree");
  });

  test("rejects any content attribute when the metadata-only tier is selected", async () => {
    const metadataOnly = { content_capture: "forbidden", timeout_ms: 300 };
    const usage = {
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      providerRequestIds: ["request-1"],
    };

    const clean = await fixture({ content_capture: "forbidden" });
    await writeFile(clean.traces, trace({ content: false }));
    await capture(clean.parameters, clean.output, usage);
    const evidence = await evidenceOf(clean.output);
    expect(evidence.content_capture).toBe("metadata_only");

    const nonModel = await fixture(metadataOnly);
    await writeFile(
      nonModel.traces,
      batch(
        rootSpan({ attributes: { "gen_ai.system_instructions": json([{ type: "text" }]) } }),
        modelSpan({ content: false }),
      ),
    );
    await expect(capture(nonModel.parameters, nonModel.output, usage)).rejects.toThrow(
      "OpenTelemetry content capture is forbidden but 1 of 2 spans carry content attributes (gen_ai.system_instructions)",
    );

    const toolDefinitions = await fixture(metadataOnly);
    await writeFile(
      toolDefinitions.traces,
      batch(
        rootSpan(),
        modelSpan({
          content: false,
          attributes: { "gen_ai.tool.definitions": json([{ name: "write_file" }]) },
        }),
      ),
    );
    await expect(
      capture(toolDefinitions.parameters, toolDefinitions.output, usage),
    ).rejects.toThrow("spans carry content attributes (gen_ai.tool.definitions)");
  });

  test("metadata-only evidence drops sensitive and unknown attributes", async () => {
    const { traces, output, parameters } = await fixture({ content_capture: "forbidden" });
    const root = rootSpan({
      name: "root name secret",
      attributes: {
        "custom.prompt": text("root attribute secret"),
        "gen_ai.operation.name": text("operation secret"),
      },
    });
    const model = modelSpan({
      name: "model name secret",
      content: false,
      attributes: {
        "gen_ai.prompt.variable.user_name": text("Ada"),
        "gen_ai.memory.query.text": text("memory secret"),
        "gen_ai.response.finish_reasons": text("finish secret"),
        "vendor.private_payload": text("vendor secret"),
      },
    });
    model.traceState = "span trace-state secret";
    model.status = { code: 2, message: "status secret" };
    model.events = [
      {
        name: "event name secret",
        timeUnixNano: START_TIME_UNIX_NANO,
        attributes: [{ key: "event.payload", value: text("event attribute secret") }],
      },
    ];
    model.links = [
      {
        traceId: OTHER_TRACE_ID,
        spanId: "c".repeat(16),
        traceState: "link trace-state secret",
        attributes: [{ key: "link.payload", value: text("link attribute secret") }],
      },
    ];
    const document = JSON.parse(batch(root, model)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<Record<string, unknown>> };
        schemaUrl?: string;
        scopeSpans: Array<{
          scope: Record<string, unknown>;
          schemaUrl?: string;
        }>;
      }>;
    };
    const resource = document.resourceSpans[0];
    const scope = resource?.scopeSpans[0];
    if (!resource || !scope) throw new Error("fixture has no resource or scope");
    resource.resource.attributes.push({
      key: "resource.payload",
      value: text("resource secret"),
    });
    resource.schemaUrl = "schema secret";
    scope.scope = {
      name: "scope name secret",
      version: "scope version secret",
      attributes: [{ key: "scope.payload", value: text("scope attribute secret") }],
    };
    scope.schemaUrl = "scope schema secret";
    await writeFile(traces, `${JSON.stringify(document)}\n`);

    await capture(parameters, output, {
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      providerRequestIds: ["request-1"],
    });

    const evidence = await evidenceOf(output);
    const serialized = JSON.stringify(evidence);
    for (const secret of [
      "secret",
      "Ada",
      "vendor.private_payload",
      "gen_ai.prompt.variable.user_name",
      "gen_ai.memory.query.text",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(evidence.spans.find((item) => item.span_id === ROOT_SPAN_ID)?.attributes).toEqual({
      "artemis.hyperion.job.id": "job-1",
    });
    const sanitizedModel = evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID);
    expect(sanitizedModel?.name).toBe("gen_ai.chat");
    expect(sanitizedModel?.resource_attributes).toEqual({});
    expect(sanitizedModel?.events).toEqual([]);
    expect(sanitizedModel?.links[0]?.attributes).toEqual({});
    expect(sanitizedModel?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.response.id": "request-1",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
    });
  });

  test("fails closed when required standard message content is missing", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, trace({ content: false }));

    await expect(
      capture(parameters, output, {
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        providerRequestIds: ["request-1"],
      }),
    ).rejects.toThrow(
      "OpenTelemetry content capture is incomplete: 0 of 1 model spans contain standard input and output messages",
    );

    const declared = await fixture({ timeout_ms: 300 });
    await writeFile(declared.traces, batch(rootSpan(), truncatedModelSpan()));
    await expect(
      capture(declared.parameters, declared.output, {
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        providerRequestIds: ["request-1"],
      }),
    ).rejects.toThrow(
      "OpenTelemetry content capture is incomplete: 0 of 1 model spans contain standard input and output messages",
    );
  });

  test("bounded content capture names the spans whose content the system bounded", async () => {
    const evidence = await boundedCapture(
      batch(rootSpan(), modelSpan(), boundedModelSpan({ spanId: "f".repeat(16) })),
    );

    expect(evidence.content_capture).toBe("content_present");
    expect(evidence.model_message_span_count).toBe(1);
    expect(evidence.content_truncation).toMatchObject({
      declared_by: CONTENT_COMPLETE_ATTRIBUTE,
      truncated_span_count: 1,
      truncated_span_ids: ["f".repeat(16)],
    });
    expect(evidence.content_truncation.bounded_span_content_bytes).toBeGreaterThan(0);
    expect(evidence.content_truncation.trace_content_bytes).toBeGreaterThan(
      evidence.content_truncation.bounded_span_content_bytes,
    );
  });

  test("bounded content capture rejects content that is absent without a declaration", async () => {
    await expect(boundedCapture(batch(rootSpan(), modelSpan({ content: false })))).rejects.toThrow(
      `OpenTelemetry content capture is incomplete: 1 of 1 model spans neither contain standard input and output messages nor declare bounded content through ${CONTENT_COMPLETE_ATTRIBUTE}`,
    );
  });

  test("bounded content capture accepts a span that kept part of its content", async () => {
    const evidence = await boundedCapture(batch(rootSpan(), boundedModelSpan()));

    expect(evidence.model_message_span_count).toBe(0);
    expect(evidence.content_truncation.truncated_span_count).toBe(1);
    expect(evidence.content_truncation.bounded_span_content_bytes).toBeGreaterThan(0);
  });

  test("bounded content capture rejects a declaration that retained nothing", async () => {
    // Otherwise a system caps every content attribute to nothing, declares the loss on each span,
    // and passes `bounded` while emitting exactly what `forbidden` would have emitted.
    await expect(boundedCapture(batch(rootSpan(), truncatedModelSpan()))).rejects.toThrow(
      `OpenTelemetry content capture policy bounded retained no content: 1 of 1 model spans declare bounded content through ${CONTENT_COMPLETE_ATTRIBUTE} and carry none`,
    );
  });

  test("captures a bounded trace configured through the parameters schema", async () => {
    const { traces, output, parameters } = await fixture({ content_capture: "bounded" });
    expect(parameters.telemetry?.content_capture).toBe("bounded");
    await writeFile(
      traces,
      batch(
        rootSpan(),
        modelSpan(),
        boundedModelSpan({
          spanId: "f".repeat(16),
          responseId: "request-2",
          tokens: { input: 50, output: 10 },
        }),
      ),
    );

    await capture(parameters, output, {
      modelCalls: 2,
      inputTokens: 150,
      outputTokens: 30,
      providerRequestIds: ["request-1", "request-2"],
    });

    const evidence = await evidenceOf(output);
    expect(evidence.model_span_count).toBe(2);
    expect(evidence.model_message_span_count).toBe(1);
    expect(evidence.content_truncation).toMatchObject({
      declared_by: CONTENT_COMPLETE_ATTRIBUTE,
      truncated_span_count: 1,
      truncated_span_ids: ["f".repeat(16)],
    });
  });

  test("rejects a content-completeness declaration that is not boolean", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(
      traces,
      batch(
        rootSpan(),
        modelSpan({ attributes: { [CONTENT_COMPLETE_ATTRIBUTE]: text("partly") } }),
      ),
    );

    await expect(capture(parameters, output)).rejects.toThrow(
      `reports ${CONTENT_COMPLETE_ATTRIBUTE} as "partly", which is not a boolean content-completeness declaration`,
    );
  });

  test("records a declared truncation under every content policy", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(traces, batch(rootSpan(), modelSpan({ contentComplete: false })));

    await capture(parameters, output);

    const evidence = await evidenceOf(output);
    expect(evidence.content_truncation.truncated_span_count).toBe(1);
    expect(evidence.model_message_span_count).toBe(1);
  });

  test("fails closed when a model span reports no usage", async () => {
    const { traces, output, parameters } = await fixture({ timeout_ms: 300 });
    await writeFile(traces, trace({ tokens: {} }));

    await expect(capture(parameters, output)).rejects.toThrow(
      `OpenTelemetry model span ${MODEL_SPAN_ID} (chat) does not report gen_ai.usage.input_tokens`,
    );
  });

  test("fails closed when captured messages do not conform to the GenAI schema", async () => {
    const missing = await fixture({ timeout_ms: 300 });
    await writeFile(
      missing.traces,
      batch(
        rootSpan(),
        modelSpan({
          attributes: {
            "gen_ai.output.messages": json([
              { role: "assistant", parts: [{ type: "text", content: "output" }] },
            ]),
          },
        }),
      ),
    );
    await expect(capture(missing.parameters, missing.output)).rejects.toThrow(
      "does not contain a finish_reason",
    );

    const empty = await fixture({ timeout_ms: 200 });
    await writeFile(empty.traces, trace({ finishReason: "" }));
    await expect(capture(empty.parameters, empty.output)).rejects.toThrow(
      "does not contain a finish_reason",
    );

    const unresponsive = await fixture({ timeout_ms: 200 });
    await writeFile(
      unresponsive.traces,
      batch(
        rootSpan(),
        modelSpan({
          attributes: {
            "gen_ai.input.messages": json([
              { role: "tool", parts: [{ type: "tool_call_response", id: "call-0" }] },
            ]),
          },
        }),
      ),
    );
    await expect(capture(unresponsive.parameters, unresponsive.output)).rejects.toThrow(
      "gen_ai.input.messages[0].parts[0] does not contain a tool response",
    );
  });

  test("records an unmapped finish reason instead of failing the trace", async () => {
    for (const unmapped of ["unknown", "STOP ", "pause_turn", "OTHER"]) {
      const { traces, output, parameters } = await fixture();
      await writeFile(traces, trace({ finishReason: unmapped }));

      await capture(parameters, output);

      const evidence = await evidenceOf(output);
      expect(evidence.unmapped_finish_reasons, unmapped).toEqual([unmapped]);
      const model = evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID);
      const messages = JSON.parse(String(model?.attributes["gen_ai.output.messages"])) as Array<{
        finish_reason: string;
      }>;
      expect(messages[0]?.finish_reason, unmapped).toBe(unmapped);
    }
  });

  test("normalizes each provider finish-reason dialect to the convention value", async () => {
    const dialects = [
      ["TOOL_CALLS", "tool_call"],
      ["FUNCTION_CALL", "tool_call"],
      ["tool_call", "tool_call"],
      ["STOP", "stop"],
      ["stop", "stop"],
      ["LENGTH", "length"],
      ["CONTENT_FILTER", "content_filter"],
      ["max_output_tokens", "length"],
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["max_tokens", "length"],
      ["tool_use", "tool_call"],
      ["refusal", "content_filter"],
      ["SAFETY", "content_filter"],
      ["RECITATION", "content_filter"],
      ["MAX_TOKENS", "length"],
      ["PROHIBITED_CONTENT", "content_filter"],
      ["MALFORMED_FUNCTION_CALL", "error"],
    ] as const;
    const evidenceByCanonical = new Map<string, string>();

    for (const [wire, canonical] of dialects) {
      const { traces, output, parameters } = await fixture();
      await writeFile(traces, trace({ finishReason: wire }));

      await capture(parameters, output);

      const evidence = await evidenceOf(output);
      const model = evidence.spans.find((item) => item.span_id === MODEL_SPAN_ID);
      const messages = JSON.parse(String(model?.attributes["gen_ai.output.messages"])) as Array<{
        finish_reason: string;
      }>;
      expect(messages[0]?.finish_reason, wire).toBe(canonical);
      expect(evidence.unmapped_finish_reasons, wire).toEqual([]);
      const serialized = JSON.stringify(evidence.spans);
      const previous = evidenceByCanonical.get(canonical);
      if (previous === undefined) evidenceByCanonical.set(canonical, serialized);
      else expect(serialized, wire).toBe(previous);
    }
  });

  test("refuses to treat self-reported telemetry as complete without product attestation", async () => {
    const { traces, output, parameters } = await fixture();
    await writeFile(traces, trace());

    await expect(
      captureTelemetry(parameters, 0, "job-1", undefined, output, new AbortController().signal),
    ).rejects.toThrow("requires complete Artemis usage accounting");
    await expect(
      capture(parameters, output, { modelCalls: 1, inputTokens: 100, outputTokens: 20 }),
    ).rejects.toThrow("requires complete Artemis provider request identities");
  });

  test("keeps the configured trace file untouched when no telemetry is configured", async () => {
    const { output } = await fixture();
    const parameters = artemisParametersSchema.parse({
      base_url: "http://127.0.0.1:8080",
      auth: { type: "none" },
      course_id: 1,
    });

    expect(await telemetryCursor(parameters)).toBeUndefined();
    expect(
      await captureTelemetry(
        parameters,
        0,
        "job-1",
        undefined,
        output,
        new AbortController().signal,
      ),
    ).toBeUndefined();
    await expect(stat(join(output, EVIDENCE_PATH))).rejects.toThrow();
  });
});
