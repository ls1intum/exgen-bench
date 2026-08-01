#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";
import { CONTROLLED_FACTORS, OBSERVED_FACTORS } from "./factors.ts";

const id = process.env.EXGEN_ADAPTER_ID || "artemis";
if (!/^artemis(?:[.\-_][a-z0-9._-]+)?$/.test(id)) {
  throw new Error(`EXGEN_ADAPTER_ID ${JSON.stringify(id)} must be "artemis" or "artemis-<arm>"`);
}

await runArtemisAdapter({
  id,
  revision: "artemis-production-api-v5-effort-profiles",
  capabilities: {
    targets: ["artemis-programming-exercise", "artemis-java-maven"],
    seed: "unsupported",
    failed_artifact_capture: "partial",
    cancellation: true,
    crash_recovery: "cancel",
    budget_dimensions: ["wall_time_ms"],
    controls: [...CONTROLLED_FACTORS],
    observes: [...OBSERVED_FACTORS],
  },
});
