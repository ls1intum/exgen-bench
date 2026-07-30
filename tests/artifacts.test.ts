import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generationResponseSchema,
  targetSchema,
  type GenerationResponse,
} from "../src/contracts.ts";
import { validateAndDigestArtifacts } from "../src/adapters/artifacts.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-artifacts-"));
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

const genericTarget = targetSchema.parse({
  id: "generic",
  adapter: "generic",
  version: "1",
  revision: "fixture",
});

function response(artifacts: GenerationResponse["artifacts"]): GenerationResponse {
  return generationResponseSchema.parse({
    protocol_version: "1",
    status: "succeeded",
    capture: { completeness: "complete" },
    artifacts,
  });
}

describe("artifact validation", () => {
  test("produces a stable tree digest", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "candidate"));
    await writeFile(join(directory, "candidate", "answer.txt"), "42\n");
    const candidate = response([{ role: "candidate", path: "candidate" }]);

    const first = await validateAndDigestArtifacts(candidate, directory, genericTarget);
    const second = await validateAndDigestArtifacts(candidate, directory, genericTarget);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("includes semantic artifact roles in the digest", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "answer.txt"), "42\n");

    const first = await validateAndDigestArtifacts(
      response([{ role: "candidate", path: "answer.txt" }]),
      directory,
      genericTarget,
    );
    const second = await validateAndDigestArtifacts(
      response([{ role: "solution", path: "answer.txt" }]),
      directory,
      genericTarget,
    );
    expect(first).not.toBe(second);
  });

  test("rejects path traversal", async () => {
    const directory = await temporaryDirectory();
    const candidate = response([{ role: "candidate", path: "../outside.txt" }]);

    await expect(validateAndDigestArtifacts(candidate, directory, genericTarget)).rejects.toThrow(
      "escapes",
    );
  });

  test("rejects symbolic links", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "real.txt"), "content");
    await symlink(join(directory, "real.txt"), join(directory, "link.txt"));
    const candidate = response([{ role: "candidate", path: "link.txt" }]);

    await expect(validateAndDigestArtifacts(candidate, directory, genericTarget)).rejects.toThrow(
      "symbolic links",
    );
  });

  test("rejects symbolic links in intermediate path components", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "secret.txt"), "not an artifact");
    await symlink(outside, join(directory, "alias"));
    const candidate = response([{ role: "candidate", path: "alias/secret.txt" }]);

    await expect(validateAndDigestArtifacts(candidate, directory, genericTarget)).rejects.toThrow(
      "symbolic links",
    );
  });

  test("rejects a symbolic-link output root", async () => {
    const parent = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "secret.txt"), "not an artifact");
    const linkedRoot = join(parent, "output");
    await symlink(outside, linkedRoot);
    const candidate = response([{ role: "candidate", path: "secret.txt" }]);

    await expect(validateAndDigestArtifacts(candidate, linkedRoot, genericTarget)).rejects.toThrow(
      "output root",
    );
  });

  test("requires all canonical roles for an Artemis candidate", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "statement.md"), "brief");
    const candidate = response([{ role: "problem_statement", path: "statement.md" }]);
    const artemisTarget = targetSchema.parse({
      id: "artemis-java",
      adapter: "artemis",
      version: "1",
      revision: "fixture",
    });

    await expect(validateAndDigestArtifacts(candidate, directory, artemisTarget)).rejects.toThrow(
      "template, solution, tests",
    );
  });
});
