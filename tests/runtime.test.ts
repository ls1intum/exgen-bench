import { describe, expect, test } from "bun:test";
import { systemSchema } from "../src/contracts.ts";
import { createRuntimeInvocation } from "../src/core/runtime.ts";

describe("runtime invocation", () => {
  test("builds a locked-down digest-pinned OCI invocation without exposing secret values", () => {
    const system = systemSchema.parse({
      id: "container-generator",
      name: "Container generator",
      version: "1",
      revision: "fixture",
      runtime: {
        type: "container",
        engine: "podman",
        image: `example.invalid/generator@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        env: { MODEL_API_KEY: "HOST_SECRET" },
        network: "provider",
        memory_mb: 2048,
        cpus: 2,
      },
    });

    const invocation = createRuntimeInvocation(system, {
      configDirectory: "/benchmark",
      arguments: ["generate", "--request", "/work/request.json"],
      mountDirectory: "/host/attempt",
      includeDeclaredEnvironment: true,
    });

    expect(invocation.argv[0]).toBe("podman");
    expect(invocation.argv).toContain("--read-only");
    expect(invocation.argv).toContain("no-new-privileges");
    expect(invocation.argv).toContain("MODEL_API_KEY");
    expect(invocation.argv).not.toContain("HOST_SECRET");
    expect(invocation.argv).toContain(`example.invalid/generator@sha256:${"a".repeat(64)}`);
  });
});
