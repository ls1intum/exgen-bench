import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidenceManifest } from "../src/core/evidence.ts";
import { readResponseTextBounded, readTextBounded } from "../src/core/files.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-evidence-"));
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

describe("bounded evidence handling", () => {
  test("rejects evidence that exceeds byte, entry, or depth limits", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "artifact.txt"), "12345");

    await expect(
      buildEvidenceManifest(directory, {
        maximumEntries: 10,
        maximumBytes: 4,
        maximumDepth: 10,
      }),
    ).rejects.toThrow("maximum size");
    await expect(
      buildEvidenceManifest(directory, {
        maximumEntries: 1,
        maximumBytes: 10,
        maximumDepth: 10,
      }),
    ).rejects.toThrow("maximum entry count");
    await expect(
      buildEvidenceManifest(directory, {
        maximumEntries: 10,
        maximumBytes: 10,
        maximumDepth: 1,
      }),
    ).rejects.toThrow("maximum depth");
  });

  test("rejects hard-linked evidence files", async () => {
    const directory = await temporaryDirectory();
    const original = join(directory, "original.txt");
    await writeFile(original, "content");
    await link(original, join(directory, "alias.txt"));

    await expect(buildEvidenceManifest(directory)).rejects.toThrow("hard-linked");
  });

  test("does not count the derived manifest against evidence limits", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "artifact.txt"), "content");
    await writeFile(join(directory, "evidence-manifest.json"), "{}");

    const manifest = await buildEvidenceManifest(directory, {
      maximumEntries: 1,
      maximumBytes: 7,
      maximumDepth: 1,
    });

    expect(manifest.files.map((entry) => entry.path)).toEqual(["artifact.txt"]);
  });

  test("never reads a protocol document beyond its byte limit", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "response.json");
    await writeFile(path, '{"status":"oversized"}');

    await expect(readTextBounded(path, 8)).rejects.toThrow("exceeds 8 bytes");
  });

  test("rejects a symbolic-link protocol document", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    await writeFile(target, "{}");
    const path = join(directory, "response.json");
    await symlink(target, path);

    await expect(readTextBounded(path, 1024)).rejects.toThrow("regular file");
  });

  test("stops reading an oversized HTTP response", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("67890"));
          controller.close();
        },
      }),
    );

    await expect(readResponseTextBounded(response, 8)).rejects.toThrow("exceeds 8 bytes");
  });
});
