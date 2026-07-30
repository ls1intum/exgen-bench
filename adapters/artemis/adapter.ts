#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";

await runArtemisAdapter({
  id: "artemis",
  revision: "artemis-benchmark-v1",
  capabilities: {
    targets: ["artemis-java-maven"],
    seed: "best_effort",
    failed_artifact_capture: "partial",
    cancellation: true,
    crash_recovery: "cancel",
  },
});
