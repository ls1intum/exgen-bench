import { isAbsolute, join } from "node:path";
import type { GenerationResponse } from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/core/files.ts";
import {
  captureOtlpTrace,
  type GenAiUsage,
  type OtlpPreflightResult,
  otlpFileCursor,
  waitForOtlpExport,
} from "../../src/telemetry/opentelemetry.ts";
import { type ArtemisParameters, resolveTelemetryPath } from "./config.ts";

const JOB_ID_ATTRIBUTE = "artemis.hyperion.job.id";
const EVIDENCE_SOURCE = "opentelemetry-collector-file-exporter";
// Artemis caps a single content attribute and drops the value beyond it, declaring the loss here.
const CONTENT_COMPLETE_ATTRIBUTE = "artemis.gen_ai.content.complete";

type Diagnostic = NonNullable<GenerationResponse["diagnostics"]>[number];

export interface TelemetryUsage extends GenAiUsage {
  providerRequestIds?: string[];
}

export interface TelemetryCapture {
  diagnostic: Diagnostic;
  traceId: string;
  spanCount: number;
  modelSpanCount: number;
}

interface TelemetryTarget {
  configuration: NonNullable<ArtemisParameters["telemetry"]>;
  path: string;
}

function telemetryTarget(parameters: ArtemisParameters): TelemetryTarget | undefined {
  const configuration = parameters.telemetry;
  if (!configuration) return undefined;
  const path = resolveTelemetryPath(parameters) ?? "";
  if (!isAbsolute(path))
    throw new Error(
      `OpenTelemetry trace path must be absolute, ${configuration.traces_path_env} resolved ${JSON.stringify(path)}`,
    );
  return { configuration, path };
}

export async function telemetryCursor(parameters: ArtemisParameters): Promise<number | undefined> {
  const target = telemetryTarget(parameters);
  return target ? await otlpFileCursor(target.path) : undefined;
}

function traceDiagnostic(path: string, bytes: Uint8Array): Diagnostic {
  return {
    id: "artemis-opentelemetry-trace",
    kind: "trace",
    path,
    media_type: "application/json",
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.byteLength,
    visibility: "restricted",
  };
}

export async function captureTelemetry(
  parameters: ArtemisParameters,
  cursor: number | undefined,
  jobId: string,
  expectedUsage: TelemetryUsage | undefined,
  outputDirectory: string,
  signal: AbortSignal,
): Promise<TelemetryCapture | undefined> {
  const target = telemetryTarget(parameters);
  if (!target) return undefined;
  const { configuration, path } = target;
  if (cursor === undefined)
    throw new Error("OpenTelemetry cursor was not captured before generation");
  if (configuration.verify_usage && !expectedUsage) {
    throw new Error("OpenTelemetry verification requires complete Artemis usage accounting");
  }
  if (configuration.verify_provider_request_ids && !expectedUsage?.providerRequestIds) {
    throw new Error(
      "OpenTelemetry verification requires complete Artemis provider request identities",
    );
  }
  const evidence = await captureOtlpTrace({
    path,
    source: EVIDENCE_SOURCE,
    cursor,
    maximumBytes: configuration.max_bytes_per_attempt,
    timeoutMs: configuration.timeout_ms,
    pollIntervalMs: configuration.poll_interval_ms,
    stablePollCount: configuration.stable_poll_count,
    correlation: { attribute: JOB_ID_ATTRIBUTE, value: jobId },
    contentPolicy: configuration.content_capture,
    contentBoundaryAttribute: CONTENT_COMPLETE_ATTRIBUTE,
    ...(configuration.verify_usage && expectedUsage ? { expectedUsage } : {}),
    ...(configuration.verify_provider_request_ids && expectedUsage?.providerRequestIds
      ? { expectedProviderRequestIds: expectedUsage.providerRequestIds }
      : {}),
    signal,
  });
  const evidencePath = "telemetry/opentelemetry-trace.json";
  await writeJsonAtomic(join(outputDirectory, evidencePath), evidence);
  return {
    diagnostic: traceDiagnostic(
      evidencePath,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    ),
    traceId: evidence.trace_id,
    spanCount: evidence.span_count,
    modelSpanCount: evidence.model_span_count,
  };
}

export async function waitForTelemetryExport(
  parameters: ArtemisParameters,
  cursor: number | undefined,
  signal?: AbortSignal,
): Promise<OtlpPreflightResult | undefined> {
  const target = telemetryTarget(parameters);
  if (!target || cursor === undefined) return undefined;
  return await waitForOtlpExport({
    path: target.path,
    cursor,
    maximumBytes: target.configuration.max_bytes_per_attempt,
    timeoutMs: target.configuration.timeout_ms,
    pollIntervalMs: target.configuration.poll_interval_ms,
    ...(signal ? { signal } : {}),
  });
}
