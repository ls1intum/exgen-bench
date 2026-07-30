#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";

await runArtemisAdapter("research", {
  id: "artemis",
  revision: "artemis-research-bridge-v1",
  capabilities: {
    targets: ["artemis-java-maven"],
    seed: "best_effort",
    failed_artifact_capture: "partial",
    cancellation: true,
  },
});
