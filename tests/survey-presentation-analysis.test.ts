import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PRESENTATION_POOLING_ERROR,
  singleFindingsPresentation,
} from "../tools/tier3-expert-rating/analysis/presentation.ts";

const data = (...ratings: Array<Record<string, unknown>>) => ({ tables: { ratings } });
const current = {
  complete: true,
  findings_presentations: "categories-v1",
  findings_presentation_at_submit: "categories-v1",
  findings_presentation_mixed: false,
};

describe("analysis presentation conditions", () => {
  test("old exports stay explicitly unversioned and a uniform current cohort is analysable", () => {
    expect(singleFindingsPresentation(data({ complete: true }, { complete: true }))).toBe(
      "legacy-unversioned",
    );
    expect(singleFindingsPresentation(data(current, current))).toBe("categories-v1");
    expect(singleFindingsPresentation(data())).toBeNull();
    expect(() => singleFindingsPresentation({ tables: {} })).toThrow("no ratings table");
  });
  test("mixed exposures are refused even if every submission uses the same current client", () => {
    expect(() =>
      singleFindingsPresentation(
        data({
          ...current,
          findings_presentations: "legacy-unversioned;categories-v1",
          findings_presentation_mixed: true,
        }),
      ),
    ).toThrow(PRESENTATION_POOLING_ERROR);
    expect(() =>
      singleFindingsPresentation(
        data({ ...current, findings_presentations: ["legacy-unversioned", "categories-v1"] }),
      ),
    ).toThrow(PRESENTATION_POOLING_ERROR);
    expect(() =>
      singleFindingsPresentation(
        data({ ...current, findings_presentations: "legacy-unversioned" }),
      ),
    ).toThrow(PRESENTATION_POOLING_ERROR);
  });
  test("completed ratings from two conditions are never silently pooled", () => {
    expect(() => singleFindingsPresentation(data({ complete: true }, current))).toThrow(
      PRESENTATION_POOLING_ERROR,
    );
    expect(() =>
      singleFindingsPresentation(
        data(current, {
          ...current,
          findings_presentations: "future-v2",
          findings_presentation_at_submit: "future-v2",
        }),
      ),
    ).toThrow(PRESENTATION_POOLING_ERROR);
  });
  test("incomplete ratings do not block a uniform completed cohort", () => {
    expect(
      singleFindingsPresentation(
        data(current, {
          ...current,
          complete: false,
          findings_presentations: "legacy-unversioned;categories-v1",
          findings_presentation_mixed: true,
        }),
      ),
    ).toBe("categories-v1");
  });
  test("duplicate observed IDs are one condition and malformed provenance is not guessed", () => {
    expect(
      singleFindingsPresentation(
        data({ ...current, findings_presentations: "categories-v1;categories-v1" }),
      ),
    ).toBe("categories-v1");
    expect(() =>
      singleFindingsPresentation(data({ ...current, findings_presentations: 42 })),
    ).toThrow("Invalid findings presentation provenance");
    expect(() =>
      singleFindingsPresentation(
        data({ ...current, findings_presentations: { unexpected: "categories-v1" } }),
      ),
    ).toThrow("Invalid findings presentation provenance");
    expect(() =>
      singleFindingsPresentation(data({ ...current, findings_presentation_at_submit: 42 })),
    ).toThrow("Invalid findings presentation provenance");
    expect(() =>
      singleFindingsPresentation(data({ ...current, findings_presentation_mixed: "true" })),
    ).toThrow("Invalid findings presentation provenance");
  });
  test("CLI rejects mixed exports before invoking Docker or replacing an existing report", async () => {
    const root = await mkdtemp(join(tmpdir(), "exgen-presentation-analysis-"));
    try {
      const input = join(root, "data.json"),
        output = join(root, "REPORT.md");
      await writeFile(input, JSON.stringify(data({ complete: true }, current)));
      await writeFile(output, "existing report");
      const binaries = join(root, "bin"),
        sentinel = join(root, "docker-was-invoked");
      await mkdir(binaries);
      const docker = join(binaries, "docker");
      await writeFile(docker, '#!/bin/sh\n: > "$EXGEN_TEST_DOCKER_SENTINEL"\nexit 23\n');
      await chmod(docker, 0o755);
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          resolve(import.meta.dir, "../src/cli.ts"),
          "survey",
          "report",
          input,
          "--output",
          root,
        ],
        {
          env: { ...process.env, PATH: binaries, EXGEN_TEST_DOCKER_SENTINEL: sentinel },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain(PRESENTATION_POOLING_ERROR);
      expect(await Bun.file(sentinel).exists()).toBe(false);
      expect(await Bun.file(output).text()).toBe("existing report");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
