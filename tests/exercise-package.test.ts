import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { datasetSchema } from "../src/contracts.ts";
import { loadExercisePackage, materializeExercisePackage } from "../src/data/exercise-package.ts";
import { loadReferenceSet, referenceSetSchema } from "../src/data/reference-set.ts";

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
        status: "ready",
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
  test("validates a package through the CLI as JSON", async () => {
    const { manifest } = await fixturePackage();
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        resolve("src/cli.ts"),
        "exercise-package",
        "validate",
        manifest,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      valid: true,
      package: "sample-reference@1.0.0",
      status: "ready",
      cases: 1,
      families: 1,
    });
  });

  test("validates complete bundles and derives a content identity", async () => {
    const { manifest } = await fixturePackage();
    const first = await loadExercisePackage(manifest);
    const second = await loadExercisePackage(manifest);

    expect(first.cases).toHaveLength(1);
    expect(first.cases[0]?.familyId).toBe("arithmetic");
    expect(first.cases[0]?.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
  });

  test("materializes a generator dataset and metric-neutral complete reference set", async () => {
    const { root, manifest } = await fixturePackage();
    await writeFile(join(root, "cases/sample/bundle/undeclared.bin"), "not part of the bundle");
    const loaded = await loadExercisePackage(manifest);
    const output = join(root, "materialized");
    const result = await materializeExercisePackage(loaded, output);

    const dataset = datasetSchema.parse(parse(await readFile(result.datasetPath, "utf8")));
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.cases[0]?.brief).toBe("./briefs/sample.md");
    expect(dataset.cases[0]?.extensions).toMatchObject({ case_family: "arithmetic" });
    const referenceSet = referenceSetSchema.parse(
      parse(await readFile(result.referenceSetPath, "utf8")),
    );
    expect(referenceSet.package).toEqual({
      id: loaded.manifest.id,
      version: loaded.manifest.version,
    });
    expect(referenceSet.cases[0]?.bundle).toBe("./reference-bundles/sample");
    expect((await loadReferenceSet(result.referenceSetPath)).cases).toHaveLength(1);
    expect(await Bun.file(join(output, "reference-bundles/sample/undeclared.bin")).exists()).toBe(
      false,
    );
    expect(
      await readFile(
        join(
          output,
          "reference-bundles/sample/artifacts/solution/src/de/tum/cit/aet/exgenevensum/EvenSum.java",
        ),
        "utf8",
      ),
    ).toContain("class EvenSum");
    expect(
      await readFile(
        join(
          output,
          "reference-bundles/sample/artifacts/tests/test/de/tum/cit/aet/exgenevensum/EvenSumTest.java",
        ),
        "utf8",
      ),
    ).toContain("class EvenSumTest");
    expect(
      await readFile(
        join(output, "reference-bundles/sample/artifacts/problem-statement.md"),
        "utf8",
      ),
    ).toContain("Even Sum");
    expect(
      await readFile(join(output, "reference-bundles/sample/response.json"), "utf8"),
    ).toContain('"protocol_version": "2"');
    expect((await readdir(output)).sort()).toEqual([
      "briefs",
      "dataset.yaml",
      "reference-bundles",
      "reference-set.yaml",
    ]);
  });

  test("refuses a changed reference-set mapping under the old digest", async () => {
    const { root, manifest } = await fixturePackage();
    const result = await materializeExercisePackage(
      await loadExercisePackage(manifest),
      join(root, "materialized"),
    );
    const referenceSet = parse(await readFile(result.referenceSetPath, "utf8"));
    referenceSet.cases[0].bundle = "./reference-bundles/changed";
    await writeFile(result.referenceSetPath, stringify(referenceSet));
    await expect(loadReferenceSet(result.referenceSetPath)).rejects.toThrow(
      "reference-set digest mismatch",
    );
  });

  test("materializes an explicit case selection and records it in the dataset", async () => {
    const { root, manifest } = await fixturePackage();
    const loaded = await loadExercisePackage(manifest);
    const result = await materializeExercisePackage(loaded, join(root, "selected"), ["sample"]);
    const dataset = datasetSchema.parse(parse(await readFile(result.datasetPath, "utf8")));

    expect(result.cases).toBe(1);
    expect(dataset.extensions.exercise_package_selection).toEqual(["sample"]);
    await expect(
      materializeExercisePackage(loaded, join(root, "duplicate"), ["sample", "sample"]),
    ).rejects.toThrow("must be unique");
    await expect(
      materializeExercisePackage(loaded, join(root, "unknown"), ["missing"]),
    ).rejects.toThrow("unknown package case IDs: missing");
  });

  test("binds reference response metadata into the package digest", async () => {
    const { root, manifest } = await fixturePackage();
    const first = await loadExercisePackage(manifest);
    const responsePath = join(root, "cases/sample/bundle/response.json");
    const response = JSON.parse(await readFile(responsePath, "utf8"));
    response.extensions = { fixture_revision: "changed" };
    await writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`);
    const second = await loadExercisePackage(manifest);
    expect(second.digest).not.toBe(first.digest);
    expect(second.cases[0]?.bundleDigest).not.toBe(first.cases[0]?.bundleDigest);
  });

  test("refuses a reference bundle changed after validation", async () => {
    const { root, manifest } = await fixturePackage();
    const loaded = await loadExercisePackage(manifest);
    const solution = join(
      root,
      "cases/sample/bundle/artifacts/solution/src/de/tum/cit/aet/exgenevensum/EvenSum.java",
    );
    await writeFile(solution, "class EvenSum { /* changed */ }\n");
    const output = join(root, "materialized");

    await expect(materializeExercisePackage(loaded, output)).rejects.toThrow(
      "changed while materializing",
    );
    expect(await Bun.file(output).exists()).toBe(false);
  });

  test("keeps analysis-only annotations out of dataset and evaluation-suite identities", async () => {
    const { root, manifest } = await fixturePackage();
    const first = await loadExercisePackage(manifest);
    const firstOutput = await materializeExercisePackage(first, join(root, "first"));

    await writeFile(
      join(root, "cases/sample/annotations.json"),
      `${JSON.stringify({ status: "reviewed", competencies: ["loops"] })}\n`,
    );
    const second = await loadExercisePackage(manifest);
    const secondOutput = await materializeExercisePackage(second, join(root, "second"));

    expect(second.digest).not.toBe(first.digest);
    expect(await readFile(secondOutput.datasetPath, "utf8")).toBe(
      await readFile(firstOutput.datasetPath, "utf8"),
    );
    expect(await readFile(secondOutput.referenceSetPath, "utf8")).toBe(
      await readFile(firstOutput.referenceSetPath, "utf8"),
    );
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

  test("refuses overlapping reference artifact roots", async () => {
    const { root, manifest } = await fixturePackage();
    const responsePath = join(root, "cases/sample/bundle/response.json");
    const response = JSON.parse(await readFile(responsePath, "utf8"));
    response.artifacts.push({ role: "assets", path: "artifacts/solution/src" });
    await writeFile(responsePath, `${JSON.stringify(response)}\n`);
    await expect(loadExercisePackage(manifest)).rejects.toThrow("overlapping artifact paths");
  });

  test("validates WIP source material but refuses to materialize incomplete cases", async () => {
    const { root, manifest } = await fixturePackage();
    const document = JSON.parse(await readFile(manifest, "utf8"));
    document.status = "wip";
    delete document.cases[0].bundle;
    document.cases[0].sources = [{ role: "source_exercise", path: "./cases/sample/brief.md" }];
    await writeFile(manifest, `${JSON.stringify(document, null, 2)}\n`);

    const loaded = await loadExercisePackage(manifest);
    expect(loaded.manifest.status).toBe("wip");
    expect(loaded.cases[0]?.bundlePath).toBeUndefined();
    expect(loaded.cases[0]?.sources[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(materializeExercisePackage(loaded, join(root, "materialized"))).rejects.toThrow(
      "cannot materialize WIP",
    );
  });

  test("refuses a ready package with an incomplete case", async () => {
    const { manifest } = await fixturePackage();
    const document = JSON.parse(await readFile(manifest, "utf8"));
    delete document.cases[0].bundle;
    await writeFile(manifest, `${JSON.stringify(document)}\n`);
    await expect(loadExercisePackage(manifest)).rejects.toThrow(
      "ready exercise packages require a complete bundle",
    );
  });
});
