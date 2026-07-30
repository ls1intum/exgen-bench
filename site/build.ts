import { appendFile, cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

export async function buildStaticSite(options: {
  outputDirectory: string;
  includeDemoData?: boolean;
  sourceDirectory?: string;
}): Promise<string> {
  const sourceDirectory = resolve(options.sourceDirectory ?? import.meta.dirname);
  const outputDirectory = resolve(options.outputDirectory);

  await build({
    configFile: resolve(sourceDirectory, "vite.config.ts"),
    root: sourceDirectory,
    base: "./",
    publicDir: false,
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      sourcemap: false,
    },
  });
  await cp(resolve(sourceDirectory, "../LICENSE"), resolve(outputDirectory, "LICENSE.txt"));
  const cssLicensePackages = [
    ["shadcn", "LICENSE.md"],
    ["tw-animate-css", "LICENSE"],
  ] as const;
  const cssLicenses = await Promise.all(
    cssLicensePackages.map(async ([name, licenseFile]) => {
      const packageDirectory = resolve(import.meta.dirname, "..", "node_modules", name);
      const metadata = JSON.parse(
        await readFile(resolve(packageDirectory, "package.json"), "utf8"),
      ) as {
        version: string;
        license: string;
      };
      const license = await readFile(resolve(packageDirectory, licenseFile), "utf8");
      return `## ${name} - ${metadata.version} (${metadata.license})\n\n${license.trim()}`;
    }),
  );
  await appendFile(
    resolve(outputDirectory, "third-party-licenses.txt"),
    `\n\n${cssLicenses.join("\n\n")}\n`,
  );

  if (options.includeDemoData) {
    await mkdir(resolve(outputDirectory, "data"), { recursive: true });
    await cp(resolve(sourceDirectory, "data"), resolve(outputDirectory, "data"), {
      recursive: true,
    });
  }
  return outputDirectory;
}

if (import.meta.main) {
  const outputDirectory = await buildStaticSite({
    outputDirectory: resolve(import.meta.dirname, "dist"),
    includeDemoData: true,
  });
  process.stdout.write(`Built results site: ${outputDirectory}\n`);
}
