#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";

await runArtemisAdapter({
  id: process.env.EXGEN_ADAPTER_ID || "artemis",
  revision: "artemis-production-api-v3-otel",
  capabilities: {
    targets: ["artemis-java-maven"],
    seed: "unsupported",
    failed_artifact_capture: "partial",
    cancellation: true,
    crash_recovery: "cancel",
  },
});
