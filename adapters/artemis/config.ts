import { z } from "zod";

function requireSecureAuthentication(
  value: { base_url: string; auth: { type: "none" } | { type: "bearer"; token_env: string } },
  context: z.RefinementCtx,
): void {
  if (value.auth.type !== "bearer") {
    return;
  }
  const url = new URL(value.base_url);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    url.hostname.startsWith("127.");
  if (url.protocol !== "https:" && !loopback) {
    context.addIssue({
      code: "custom",
      path: ["base_url"],
      message: "bearer authentication requires HTTPS except for loopback test servers",
    });
  }
}

export const artemisParametersSchema = z
  .object({
    base_url: z.string().url(),
    auth: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("none") }).strict(),
        z
          .object({
            type: z.literal("bearer"),
            token_env: z.string().min(1).default("ARTEMIS_API_TOKEN"),
          })
          .strict(),
      ])
      .default({ type: "bearer", token_env: "ARTEMIS_API_TOKEN" }),
    approach: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .default({ id: "hyperion.full" }),
    model_profile: z.string().min(1).optional(),
    scaffold_ref: z.string().min(1).optional(),
    poll_interval_ms: z.number().int().positive().max(60_000).default(1_000),
    request_timeout_ms: z.number().int().positive().max(120_000).default(30_000),
    max_http_retries: z.number().int().nonnegative().max(10).default(3),
    max_http_response_bytes: z
      .number()
      .int()
      .positive()
      .max(1536 * 1024 * 1024)
      .default(320 * 1024 * 1024),
    max_artifact_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(256 * 1024 * 1024),
    request_extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine(requireSecureAuthentication);

export type ArtemisParameters = z.infer<typeof artemisParametersSchema>;

export function resolveAuthorization(parameters: ArtemisParameters): string | undefined {
  if (parameters.auth.type === "none") {
    return undefined;
  }
  const token = process.env[parameters.auth.token_env];
  if (!token) {
    throw new Error(`missing Artemis credential environment variable ${parameters.auth.token_env}`);
  }
  return `Bearer ${token}`;
}
