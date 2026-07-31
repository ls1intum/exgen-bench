import { describe, expect, test } from "bun:test";
import { generationExecutionSchema } from "../src/contracts.ts";

describe("generation execution provenance", () => {
  test("requires an effective value when a generator claims the seed was honored", () => {
    expect(() =>
      generationExecutionSchema.parse({
        requested_seed: 42,
        seed_status: "honored",
        effective_parameters: { temperature: 0 },
        provider_request_ids: ["request-1"],
        provider_request_ids_complete: true,
      }),
    ).toThrow("effective seed");

    expect(
      generationExecutionSchema.parse({
        requested_seed: 42,
        seed_status: "unsupported",
        effective_parameters: { temperature: 0 },
        provider_request_ids: ["request-1"],
        provider_request_ids_complete: true,
      }).seed_status,
    ).toBe("unsupported");
  });
});
