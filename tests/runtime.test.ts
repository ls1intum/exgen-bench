import { describe, expect, test } from "bun:test";
import { systemSchema } from "../src/contracts.ts";
import { createRuntimeInvocation } from "../src/core/runtime.ts";

describe("runtime invocation", () => {
  test("rejects root or mutable container configurations", () => {
    const base = {
      id: "container-generator",
      name: "Container generator",
      version: "1",
      revision: "fixture",
      runtime: {
        type: "container",
        image: `example.invalid/generator@sha256:${"a".repeat(64)}`,
        memory_mb: 2048,
        cpus: 2,
        user: "65532:65532",
      },
      attestation: { deployment_deviations: [] },
    };

    expect(
      systemSchema.safeParse({ ...base, runtime: { ...base.runtime, user: "0:0" } }).success,
    ).toBe(false);
    expect(
      systemSchema.safeParse({ ...base, runtime: { ...base.runtime, read_only: false } }).success,
    ).toBe(false);
  });

  test("builds a locked-down digest-pinned OCI invocation without exposing secret values", () => {
    const system = systemSchema.parse({
      id: "container-generator",
      name: "Container generator",
      version: "1",
      revision: "fixture",
      attestation: { deployment_deviations: [] },
      runtime: {
        type: "container",
        engine: "podman",
        image: `example.invalid/generator@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        env: { MODEL_API_KEY: "HOST_SECRET" },
        network: "bridge",
        memory_mb: 2048,
        cpus: 2,
        user: "65532:65532",
      },
    });

    const invocation = createRuntimeInvocation(system, {
      configDirectory: "/benchmark",
      arguments: ["generate", "--request", "/benchmark/request.json", "--output", "/work/output"],
      mounts: [
        {
          source: "/host/attempt/request.json",
          target: "/benchmark/request.json",
          readOnly: true,
        },
        { source: "/host/attempt/output", target: "/work/output", readOnly: false },
      ],
      containerWorkingDirectory: "/work/output",
      containerName: "exgen-attempt-id",
      includeDeclaredEnvironment: true,
    });

    expect(invocation.argv[0]).toBe("podman");
    expect(invocation.argv).toContain("--read-only");
    expect(invocation.argv).toContain("no-new-privileges");
    expect(invocation.argv).toContain("65532:65532");
    expect(invocation.argv).toContain("MODEL_API_KEY");
    expect(invocation.argv).not.toContain("HOST_SECRET");
    expect(invocation.argv).toContain(`example.invalid/generator@sha256:${"a".repeat(64)}`);
    expect(invocation.argv).toContain(
      "type=bind,src=/host/attempt/request.json,dst=/benchmark/request.json,readonly",
    );
    expect(invocation.argv).toContain("type=bind,src=/host/attempt/output,dst=/work/output");
    expect(invocation.argv).not.toContain("type=bind,src=/host/attempt,dst=/work");
    expect(invocation.argv).toContain("exgen-attempt-id");
  });
});
