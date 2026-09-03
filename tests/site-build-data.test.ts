import { afterEach, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSiteFromData } from "../site/build-data.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ data: string; output: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "exgen-site-build-data-"));
  temporaryDirectories.push(root);
  const data = join(root, "projected-release-data");
  await cp(resolve("site/data"), data, { recursive: true });
  return { data, output: join(root, "site"), root };
}

test("builds validated existing site data", async () => {
  const { data, output } = await fixture();
  expect(await buildSiteFromData({ dataDirectory: data, outputDirectory: output })).toBe(output);
  expect((await lstat(join(output, "index.html"))).isFile()).toBeTrue();
  expect((await lstat(join(output, "data/catalog.json"))).isFile()).toBeTrue();
});

test("does not publish invalid data", async () => {
  const { data, output } = await fixture();
  await writeFile(join(data, "catalog.json"), "{}\n");
  await expect(
    buildSiteFromData({ dataDirectory: data, outputDirectory: output }),
  ).rejects.toThrow();
  await expect(lstat(output)).rejects.toThrow();
});

test("does not replace an existing output", async () => {
  const { data, output } = await fixture();
  await mkdir(output);
  await writeFile(join(output, "keep.txt"), "keep\n");
  await expect(buildSiteFromData({ dataDirectory: data, outputDirectory: output })).rejects.toThrow(
    "already exists",
  );
  expect(await Bun.file(join(output, "keep.txt")).text()).toBe("keep\n");
});
