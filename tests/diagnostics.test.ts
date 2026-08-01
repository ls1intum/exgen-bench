import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDiagnostics } from "../src/adapters/diagnostics.ts";
import { sha256 } from "../src/core/canonical.ts";
import { generationResponseSchema } from "../src/contracts.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function journal(path: string, bytes: Uint8Array, recordCount = 1) {
  return generationResponseSchema.parse({
    protocol_version: "2",
    status: "failed",
    capture: { completeness: "none" },
    diagnostics: [
      {
        id: "events",
        kind: "event_journal",
        path,
        media_type: "application/x-ndjson",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
        record_count: recordCount,
      },
    ],
  });
}

function response(path: string, contents: string, recordCount = 1) {
  return journal(path, new TextEncoder().encode(contents), recordCount);
}

describe("diagnostic evidence validation", () => {
  test("accepts a digest-linked restricted diagnostic", async () => {
    const directory = await temporaryDirectory();
    const contents = '{"sequence":1,"type":"started"}\n';
    await writeFile(join(directory, "events.jsonl"), contents);

    await expect(validateDiagnostics(response("events.jsonl", contents), directory)).resolves.toBe(
      undefined,
    );
  });

  test("rejects path traversal, digest mismatch, and size mismatch", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "events.jsonl"), "changed\n");

    await expect(
      validateDiagnostics(response("../events.jsonl", "changed\n"), directory),
    ).rejects.toThrow("escapes");
    await expect(
      validateDiagnostics(response("events.jsonl", "expected\n"), directory),
    ).rejects.toThrow("size does not match");

    const sameLength = response("events.jsonl", "content\n");
    await expect(validateDiagnostics(sameLength, directory)).rejects.toThrow(
      "digest does not match",
    );
  });

  test("rejects symbolic links and hard links", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const contents = "restricted\n";
    await writeFile(join(outside, "events.jsonl"), contents);
    await symlink(outside, join(directory, "alias"));

    await expect(
      validateDiagnostics(response("alias/events.jsonl", contents), directory),
    ).rejects.toThrow("symbolic links");

    await link(join(outside, "events.jsonl"), join(directory, "hard-link.jsonl"));
    await expect(
      validateDiagnostics(response("hard-link.jsonl", contents), directory),
    ).rejects.toThrow("hard links");
  });

  test("keeps restricted diagnostics outside candidate artifacts", async () => {
    const directory = await temporaryDirectory();
    const contents = "private trace\n";
    await mkdir(join(directory, "candidate"));
    await writeFile(join(directory, "candidate", "events.jsonl"), contents);
    const candidate = generationResponseSchema.parse({
      ...response("candidate/events.jsonl", contents),
      artifacts: [{ role: "candidate", path: "candidate" }],
      capture: { completeness: "partial" },
    });

    await expect(validateDiagnostics(candidate, directory)).rejects.toThrow(
      "overlaps candidate artifacts",
    );
  });

  test("rejects an event journal whose declared record count is wrong", async () => {
    const directory = await temporaryDirectory();
    const contents = '{"sequence":1}\n{"sequence":2}\n';
    await writeFile(join(directory, "events.jsonl"), contents);

    await expect(
      validateDiagnostics(response("events.jsonl", contents, 5), directory),
    ).rejects.toThrow("record count does not match: events.jsonl (declared 5, counted 2)");
  });

  test("rejects an event journal record that is not JSON", async () => {
    const directory = await temporaryDirectory();
    const contents = '{"sequence":1}\nnot json at all\n';
    await writeFile(join(directory, "events.jsonl"), contents);

    await expect(
      validateDiagnostics(response("events.jsonl", contents, 2), directory),
    ).rejects.toThrow("contains invalid JSON");
  });

  test("rejects an event journal that is not valid UTF-8", async () => {
    const directory = await temporaryDirectory();
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
    await writeFile(join(directory, "events.jsonl"), bytes);

    await expect(validateDiagnostics(journal("events.jsonl", bytes), directory)).rejects.toThrow(
      "is not valid UTF-8",
    );
  });

  test("rejects an event journal without a trailing newline", async () => {
    const directory = await temporaryDirectory();
    const contents = '{"sequence":1}';
    await writeFile(join(directory, "events.jsonl"), contents);

    await expect(
      validateDiagnostics(response("events.jsonl", contents), directory),
    ).rejects.toThrow("has an incomplete final record");
  });

  test("rejects an event journal that is not declared as NDJSON", async () => {
    const declare = (mediaType: string) =>
      generationResponseSchema.safeParse({
        protocol_version: "2",
        status: "failed",
        capture: { completeness: "none" },
        diagnostics: [
          {
            id: "events",
            kind: "event_journal",
            path: "events.jsonl",
            media_type: mediaType,
            sha256: sha256("events"),
            size_bytes: 6,
            record_count: 1,
          },
        ],
      });

    const rejected = declare("text/plain");
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((issue) => issue.message)).toContain(
      "event journals must use application/x-ndjson",
    );
    expect(declare("application/x-ndjson").success).toBe(true);
  });

  test("rejects declared diagnostic sizes that exceed the aggregate limit", async () => {
    const directory = await temporaryDirectory();
    const declared = generationResponseSchema.parse({
      protocol_version: "2",
      status: "failed",
      capture: { completeness: "none" },
      diagnostics: [1, 2, 3].map((ordinal) => ({
        id: `trace-${ordinal}`,
        kind: "trace",
        path: `trace-${ordinal}.bin`,
        media_type: "application/octet-stream",
        sha256: sha256(`trace-${ordinal}`),
        size_bytes: 64 * 1024 * 1024,
      })),
    });

    await expect(validateDiagnostics(declared, directory)).rejects.toThrow(
      "diagnostics exceed the aggregate size limit of 134217728 bytes: 201326592 declared",
    );
  });
});
