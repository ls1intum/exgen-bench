import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildStaticSite } from "./build.ts";
import { validateSite } from "./validate.ts";

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`site output already exists: ${path}`);
}

export async function buildSiteFromData(options: {
  dataDirectory: string;
  outputDirectory: string;
  publicUrl?: string;
}): Promise<string> {
  const dataDirectory = resolve(options.dataDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  await requireAbsent(outputDirectory);

  const validationRoot = await mkdtemp(join(tmpdir(), "exgen-site-data-"));
  let stagingDirectory: string | undefined;
  try {
    await cp(dataDirectory, join(validationRoot, "data"), { recursive: true });
    await validateSite(validationRoot);
    await mkdir(dirname(outputDirectory), { recursive: true });
    stagingDirectory = await mkdtemp(join(dirname(outputDirectory), ".exgen-site-"));
    await buildStaticSite({
      outputDirectory: stagingDirectory,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    });
    await cp(join(validationRoot, "data"), join(stagingDirectory, "data"), { recursive: true });
    await validateSite(stagingDirectory);
    await rename(stagingDirectory, outputDirectory);
    stagingDirectory = undefined;
    return outputDirectory;
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
