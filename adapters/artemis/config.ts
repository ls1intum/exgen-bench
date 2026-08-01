import { z } from "zod";

const credentialAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), token_env: z.string().min(1) }),
  z.strictObject({
    type: z.literal("password"),
    username_env: z.string().min(1),
    password_env: z.string().min(1),
  }),
]);

const costReconciliationSchema = z.strictObject({
  provider: z.literal("openrouter"),
  api_key_env: z.string().min(1),
  base_url: z.url().default("https://openrouter.ai/api/v1"),
  currency: z.literal("USD").default("USD"),
  max_response_bytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  max_lookups: z.number().int().positive().max(10_000).default(500),
  lookup_budget_ms: z.number().int().positive().max(3_600_000).default(300_000),
  indexing_timeout_ms: z.number().int().positive().max(600_000).default(30_000),
});

const telemetrySchema = z.strictObject({
  provider: z.literal("opentelemetry"),
  traces_path_env: z.string().min(1),
  artemis_otlp_endpoint: z.url(),
  // No default. This decides whether prompts and completions land in the evidence file, and
  // docs/TELEMETRY.md describes the content tier as a deliberate selection. A silent default is not
  // a selection, so a campaign must state which tier it runs under.
  content_capture: z.enum(["required", "forbidden"]),
  timeout_ms: z.number().int().positive().max(120_000).default(15_000),
  poll_interval_ms: z.number().int().positive().max(5_000).default(250),
  stable_poll_count: z.number().int().min(1).max(10).default(2),
  max_bytes_per_attempt: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .default(32 * 1024 * 1024),
  verify_usage: z.boolean().default(true),
  verify_provider_request_ids: z.boolean().default(true),
});

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    LOOPBACK_IPV4.test(hostname)
  );
}

export const artemisParametersSchema = z
  .strictObject({
    base_url: z.url(),
    auth: credentialAuthSchema,
    course_id: z.number().int().positive(),
    cost_reconciliation: costReconciliationSchema.optional(),
    telemetry: telemetrySchema.optional(),
    exercise: z
      .strictObject({
        short_name_prefix: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9]{0,7}$/)
          .default("exgen"),
      })
      .default({ short_name_prefix: "exgen" }),
    // Artemis reports which model identifiers a job used but never which endpoint served them, so
    // the provider is an operator declaration. Without it the response carries the identifier and
    // makes no provider claim.
    model_provider: z.string().min(1).optional(),
    // Artemis enforces these but exposes none of them, so an operator who wants them in the
    // evidence has to declare what the deployment is configured with. Anything left out is recorded
    // as unknown rather than as absent.
    server_limits: z
      .strictObject({
        max_job_duration_ms: z.number().int().positive().optional(),
        max_tokens_per_job: z.number().int().positive().optional(),
        max_turns: z.number().int().positive().optional(),
        context_window_tokens: z.number().int().positive().optional(),
        admission_max_tokens_per_user: z.number().int().positive().optional(),
      })
      .optional(),
    poll_interval_ms: z.number().int().positive().max(60_000).default(5_000),
    request_timeout_ms: z.number().int().positive().max(120_000).default(30_000),
    max_http_retries: z.number().int().nonnegative().max(10).default(3),
    max_retry_delay_ms: z.number().int().positive().max(300_000).default(30_000),
    accounting_settle_ms: z.number().int().positive().max(900_000).default(60_000),
    post_cancel_budget_ms: z.number().int().positive().max(120_000).default(5_000),
    max_http_response_bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    max_http_total_bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024),
    max_artifact_bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    max_archive_files: z.number().int().positive().max(100_000).default(10_000),
    max_archive_ratio: z.number().positive().max(10_000).default(200),
    max_event_count: z.number().int().positive().max(100_000).default(10_000),
    max_event_bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
  })
  .superRefine((value, context) => {
    const url = new URL(value.base_url);
    if (value.auth.type !== "none" && url.protocol !== "https:" && !isLoopback(url.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "authenticated Artemis connections require HTTPS except on loopback",
      });
    }
    if (value.max_http_total_bytes < value.max_http_response_bytes) {
      context.addIssue({
        code: "custom",
        path: ["max_http_total_bytes"],
        message: "the cumulative HTTP limit must allow one maximum-size response",
      });
    }
    // A repository export sized between the two would fail at the HTTP layer, so the artifact bound
    // would never be the bound that decided anything.
    if (value.max_artifact_bytes > value.max_http_response_bytes) {
      context.addIssue({
        code: "custom",
        path: ["max_artifact_bytes"],
        message: "the artifact limit must be reachable through one HTTP response",
      });
    }
  });

export type ArtemisParameters = z.infer<typeof artemisParametersSchema>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing Artemis credential environment variable ${name}`);
  }
  return value;
}

export type ArtemisCredentials =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "password"; username: string; password: string };

export function resolveCredentials(parameters: ArtemisParameters): ArtemisCredentials {
  if (parameters.auth.type === "none") return { type: "none" };
  if (parameters.auth.type === "bearer") {
    return { type: "bearer", token: requiredEnvironment(parameters.auth.token_env) };
  }
  return {
    type: "password",
    username: requiredEnvironment(parameters.auth.username_env),
    password: requiredEnvironment(parameters.auth.password_env),
  };
}

export function resolveTelemetryPath(parameters: ArtemisParameters): string | undefined {
  const environmentName = parameters.telemetry?.traces_path_env;
  if (!environmentName) return undefined;
  return requiredEnvironment(environmentName);
}

export function withoutUsageVerification(parameters: ArtemisParameters): ArtemisParameters {
  if (!parameters.telemetry) return parameters;
  return {
    ...parameters,
    telemetry: {
      ...parameters.telemetry,
      verify_usage: false,
      verify_provider_request_ids: false,
    },
  };
}
