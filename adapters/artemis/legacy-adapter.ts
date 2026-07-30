#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";

await runArtemisAdapter("legacy-pilot", {
  id: "artemis-legacy-pilot",
  revision: "artemis-legacy-pilot-bridge-v1",
  capabilities: {
    targets: ["artemis-java-maven"],
    seed: "unsupported",
    failed_artifact_capture: "none",
    cancellation: true,
  },
});
