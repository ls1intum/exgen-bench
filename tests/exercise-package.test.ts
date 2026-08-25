import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { datasetSchema } from "../src/contracts.ts";
import { loadExercisePackage, materializeExercisePackage } from "../src/data/exercise-package.ts";

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixturePackage(): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), "exgen-exercise-package-"));
  temporaries.push(root);
  await mkdir(join(root, "cases", "sample"), { recursive: true });
  await writeFile(
    join(root, "cases", "sample", "brief.md"),
    "Create an introductory Java exercise about addition.\n",
  );
  await writeFile(
    join(root, "cases", "sample", "annotations.json"),
    `${JSON.stringify({ status: "draft" })}\n`,
  );
  await cp(
    resolve("evaluators/fixtures/correct-exercise/bundle"),
    join(root, "cases", "sample", "bundle"),
    { recursive: true },
  );
  const manifest = join(root, "package.json");
  await writeFile(
    manifest,
    `${JSON.stringify(
      {
        schema_version: "1",
        id: "sample-reference",
        version: "1.0.0",
        title: "Sample reference exercises",
        description: "A package used to exercise the external data contract.",
        license: "MIT",
        cases: [
          {
            id: "sample",
            family_id: "arithmetic",
            title: "Addition",
            brief: "./cases/sample/brief.md",
            bundle: "./cases/sample/bundle",
            annotations: "./cases/sample/annotations.json",
            tags: ["java"],
            origin: { kind: "synthetic", created_at: "2026-08-25" },
            authors: [{ name: "Fixture Author" }],
            license: "MIT",
            exposure: {
              generator_visible: true,
              known_public: false,
              notes: "Test fixture.",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { root, manifest };
}

describe("external exercise packages", () => {
  test("validates complete bundles and derives a content identity", async () => {
    const { manifest } = await fixturePackage();
    const first = await loadExercisePackage(manifest);
    const second = await loadExercisePackage(manifest);

    expect(first.cases).toHaveLength(1);
    expect(first.cases[0]?.familyId).toBe("arithmetic");
    expect(first.cases[0]?.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
  });

  test("materializes the existing dataset and golden-reference layouts", async () => {
    const { root, manifest } = await fixturePackage();
    const loaded = await loadExercisePackage(manifest);
    const output = join(root, "materialized");
    const result = await materializeExercisePackage(loaded, output);

    const dataset = datasetSchema.parse(parse(await readFile(result.datasetPath, "utf8")));
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]?.brief).toBe("./briefs/sample.md");
    expect(dataset.cases[0]?.extensions).toMatchObject({ case_family: "arithmetic" });
    expect(
      await readFile(
        join(output, "references/sample/solution/src/de/tum/in/ase/EvenSum.java"),
        "utf8",
      ),
    ).toContain("class EvenSum");
    expect(
      await readFile(
        join(output, "references/sample/tests/src/de/tum/in/ase/EvenSumTest.java"),
        "utf8",
      ),
    ).toContain("class EvenSumTest");
  });

  test("refuses paths that escape the package", async () => {
    const { manifest } = await fixturePackage();
    const document = JSON.parse(await readFile(manifest, "utf8"));
    document.cases[0].brief = "../outside.md";
    await writeFile(manifest, `${JSON.stringify(document)}\n`);

    await expect(loadExercisePackage(manifest)).rejects.toThrow("escapes");
  });

  test("refuses symbolic links in package inputs", async () => {
    const { root, manifest } = await fixturePackage();
    await symlink(join(root, "cases/sample/brief.md"), join(root, "linked-brief.md"));
    const document = JSON.parse(await readFile(manifest, "utf8"));
    document.cases[0].brief = "./linked-brief.md";
    await writeFile(manifest, `${JSON.stringify(document)}\n`);

    await expect(loadExercisePackage(manifest)).rejects.toThrow("symbolic links");
  });

  test("refuses duplicate case identities", async () => {
    const { manifest } = await fixturePackage();
    const document = JSON.parse(await readFile(manifest, "utf8"));
    document.cases.push(document.cases[0]);
    await writeFile(manifest, `${JSON.stringify(document)}\n`);

    await expect(loadExercisePackage(manifest)).rejects.toThrow("case IDs must be unique");
  });
});
