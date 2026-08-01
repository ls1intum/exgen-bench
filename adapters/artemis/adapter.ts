#!/usr/bin/env bun

import { runArtemisAdapter } from "./entrypoint.ts";
import { CONTROLLED_FACTORS, OBSERVED_FACTORS } from "./factors.ts";

const id = process.env.EXGEN_ADAPTER_ID || "artemis";
// One binary may present as several arms, but not as a different system: a contrast between two
// arms of this adapter must come from what they configure, not from what they call themselves.
if (!/^artemis(?:[.\-_][a-z0-9._-]+)?$/.test(id)) {
  throw new Error(`EXGEN_ADAPTER_ID ${JSON.stringify(id)} must be "artemis" or "artemis-<arm>"`);
}

await runArtemisAdapter({
  id,
  revision: "artemis-production-api-v5-effort-profiles",
  capabilities: {
    // The format lives in target.parameters. `artemis-java-maven` additionally names part of it in
    // the identifier, and the adapter rejects parameters that disagree with the name.
    targets: ["artemis-programming-exercise", "artemis-java-maven"],
    seed: "unsupported",
    failed_artifact_capture: "partial",
    cancellation: true,
    crash_recovery: "cancel",
    // The adapter itself only ever stops an attempt on the clock; every token, call and cost bound
    // that binds is one Artemis enforces.
    budget_dimensions: ["wall_time_ms"],
    // Two lists, not one, because the asymmetry is real: Artemis also applies `maxTokens` and
    // `maxJobDuration` but attests neither, so those stay parameters rather than factors this
    // adapter would be vouching for. Taken from the constants that enforce them at request time.
    controls: [...CONTROLLED_FACTORS],
    observes: [...OBSERVED_FACTORS],
  },
});
