import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStaticSite } from "../site/build.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("builds safe metadata for a public site", async () => {
  const root = await mkdtemp(join(tmpdir(), "exgen-site-build-"));
  temporaryDirectories.push(root);
  const outputDirectory = join(root, "site");
  const localOutputDirectory = join(root, "local-site");

  await buildStaticSite({
    outputDirectory,
    publicUrl: "https://example.edu/research/exgen",
  });

  const index = await readFile(join(outputDirectory, "index.html"), "utf8");
  expect(index.match(/rel="canonical"/g)).toHaveLength(1);
  expect(index).toContain('<link rel="canonical" href="https://example.edu/research/exgen/">');
  expect(index).toContain(
    '<meta property="og:image" content="https://example.edu/research/exgen/social-preview.png">',
  );
  expect((await lstat(join(outputDirectory, "social-preview.png"))).isFile()).toBeTrue();
  await expect(lstat(join(outputDirectory, "social-preview.html"))).rejects.toThrow();

  await buildStaticSite({ outputDirectory: localOutputDirectory });
  const localIndex = await readFile(join(localOutputDirectory, "index.html"), "utf8");
  expect(localIndex).not.toContain('rel="canonical"');
  await expect(lstat(join(localOutputDirectory, "social-preview.png"))).rejects.toThrow();
});

test("rejects unsafe public URLs before building", async () => {
  const root = await mkdtemp(join(tmpdir(), "exgen-site-url-validation-"));
  temporaryDirectories.push(root);
  const invalidUrls = [
    "javascript:alert(1)",
    "https://user@example.edu/results",
    "https://example.edu/results?draft=true",
    "https://example.edu/results#draft",
  ];

  for (const publicUrl of invalidUrls) {
    await expect(
      buildStaticSite({
        outputDirectory: join(root, "unused"),
        publicUrl,
      }),
    ).rejects.toThrow();
  }
});
