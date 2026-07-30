import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  formalReleaseDesignationSchema,
  publicAttemptSchema,
  publicCatalogSchema,
  publicReleaseSchema,
} from "../site/contracts.ts";
import { validateReleaseData, validateSite } from "../site/validate.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function copiedSiteData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exgen-site-validation-"));
  temporaryDirectories.push(root);
  await cp(resolve("site/data"), join(root, "data"), { recursive: true });
  return root;
}

describe("static public evidence explorer", () => {
  test("reconciles every illustrative release and downloadable checksum", async () => {
    const releases = await validateSite(resolve("site"));
    expect(releases).toHaveLength(1);
    expect(releases[0]?.status).toBe("illustrative");
    expect(releases[0]?.release_version).toBe("0.1.0");
    expect(releases[0]?.designation.status).toBe("illustrative");
  });

  test("rejects inconsistent public accounting and lifecycle aggregates", async () => {
    const release = (await validateSite(resolve("site")))[0];
    if (!release) throw new Error("missing illustrative release");
    const attemptRows = (await readFile(resolve("site/data/demo-v0.1/attempts.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);

    const badFunnel = structuredClone(release);
    const completedStage = badFunnel.execution_coverage.find((stage) => stage.id === "completed");
    if (!completedStage) throw new Error("missing completion stage");
    completedStage.count += 1;
    expect(() => validateReleaseData(badFunnel, attemptRows)).toThrow(
      "execution coverage count disagrees",
    );

    const badSystem = structuredClone(release);
    const firstSystem = badSystem.systems[0];
    if (!firstSystem) throw new Error("missing system");
    firstSystem.completed -= 1;
    expect(() => validateReleaseData(badSystem, attemptRows)).toThrow(
      "lifecycle counts do not reconcile",
    );
  });

  test("restricts formal release designations", () => {
    expect(formalReleaseDesignationSchema.parse({ status: "exploratory" })).toEqual({
      status: "exploratory",
    });
    expect(() =>
      formalReleaseDesignationSchema.parse({
        status: "exploratory",
        approved_by: "self-issued",
      }),
    ).toThrow();
    expect(() => formalReleaseDesignationSchema.parse({ status: "submitted" })).toThrow();
  });

  test("rejects unsafe colors and invalid cross-field accounting before a browser sees it", async () => {
    const release = (await validateSite(resolve("site")))[0];
    if (!release) throw new Error("missing illustrative release");
    const unsafeColor = structuredClone(release);
    const firstSystem = unsafeColor.systems[0];
    const firstCase = unsafeColor.cases[0];
    if (!firstSystem || !firstCase?.systems.orchard) {
      throw new Error("incomplete illustrative fixture");
    }
    firstSystem.color = "#fff;background:url(https://attacker.invalid)";
    expect(() => publicReleaseSchema.parse(unsafeColor)).toThrow("six-digit hexadecimal color");

    const unsafeDownload = structuredClone(release);
    const firstDownload = unsafeDownload.downloads[0];
    if (!firstDownload) throw new Error("incomplete illustrative fixture");
    firstDownload.path = "./../outside.json";
    expect(() => publicReleaseSchema.parse(unsafeDownload)).toThrow("traversal-free relative");

    const invalidCase = structuredClone(release);
    const invalidFirstCase = invalidCase.cases[0];
    if (!invalidFirstCase?.systems.orchard) {
      throw new Error("incomplete illustrative fixture");
    }
    invalidFirstCase.systems.orchard.accepted = 1;
    expect(() => publicReleaseSchema.parse(invalidCase)).toThrow(
      "denominator must equal the sum of mutually exclusive final dispositions",
    );
  });

  test("requires an explicit immutable default release", () => {
    expect(() =>
      publicCatalogSchema.parse({
        schema_version: "1",
        default_release_id: "absent",
        releases: [
          {
            id: "present",
            label: "Present",
            manifest: "./present/release.json",
            status: "exploratory",
          },
        ],
      }),
    ).toThrow("default_release_id must identify a catalog release");
  });

  test("keeps evaluator acceptance distinct from a budget-gated final disposition", () => {
    expect(
      publicAttemptSchema.parse({
        observation_id: "attempt-1",
        case_id: "case-1",
        system_id: "system-1",
        replicate: 1,
        lifecycle: "completed",
        outcome: "budget_exceeded",
        strict_accepted: false,
        evaluator_strict_accepted: true,
        generation_completed: true,
      }),
    ).toMatchObject({
      outcome: "budget_exceeded",
      strict_accepted: false,
      evaluator_strict_accepted: true,
    });
  });

  test("rejects files and links not declared by a published release", async () => {
    const root = await copiedSiteData();
    const releaseDirectory = join(root, "data/demo-v0.1");
    await writeFile(join(releaseDirectory, "unexpected.txt"), "unexpected\n");
    await expect(validateSite(root)).rejects.toThrow("published release inventory mismatch");
    await rm(join(releaseDirectory, "unexpected.txt"));

    await symlink("release.json", join(releaseDirectory, "unexpected-link"));
    await expect(validateSite(root)).rejects.toThrow("symbolic link");
  });

  test("rejects a symbolic link in a catalog path before reading it", async () => {
    const root = await copiedSiteData();
    const releaseDirectory = join(root, "data/demo-v0.1");
    const outside = await mkdtemp(join(tmpdir(), "exgen-site-release-"));
    temporaryDirectories.push(outside);
    await cp(releaseDirectory, join(outside, "release"), { recursive: true });
    await rm(releaseDirectory, { recursive: true });
    await symlink(join(outside, "release"), releaseDirectory);

    await expect(validateSite(root)).rejects.toThrow("symbolic link");
  });
});
