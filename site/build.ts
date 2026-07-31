import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const SITE_TITLE = "exgen-bench — Programming exercise generation benchmark";
const SITE_DESCRIPTION =
  "Open-source infrastructure for reproducible evaluation of systems that generate autograder-ready programming exercises from instructor briefs.";

function publicSiteUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("public site URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("public site URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function socialMetadata(publicUrl: string): string {
  const url = publicSiteUrl(publicUrl);
  const preview = new URL("social-preview.png", url).toString();
  const entries = [
    `<link rel="canonical" href="${escapeAttribute(url)}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="exgen-bench" />',
    `<meta property="og:title" content="${escapeAttribute(SITE_TITLE)}" />`,
    `<meta property="og:description" content="${escapeAttribute(SITE_DESCRIPTION)}" />`,
    `<meta property="og:url" content="${escapeAttribute(url)}" />`,
    `<meta property="og:image" content="${escapeAttribute(preview)}" />`,
    '<meta property="og:image:width" content="1280" />',
    '<meta property="og:image:height" content="640" />',
    '<meta property="og:image:alt" content="exgen-bench project overview" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeAttribute(SITE_TITLE)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(SITE_DESCRIPTION)}" />`,
    `<meta name="twitter:image" content="${escapeAttribute(preview)}" />`,
    '<meta name="twitter:image:alt" content="exgen-bench project overview" />',
  ];
  return entries.map((entry) => `    ${entry}`).join("\n");
}

export async function buildStaticSite(options: {
  outputDirectory: string;
  includeDemoData?: boolean;
  publicUrl?: string;
  sourceDirectory?: string;
}): Promise<string> {
  const sourceDirectory = resolve(options.sourceDirectory ?? import.meta.dirname);
  const outputDirectory = resolve(options.outputDirectory);
  const metadata = options.publicUrl ? socialMetadata(options.publicUrl) : undefined;

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
  const providerNotices = await readFile(
    resolve(sourceDirectory, "assets/providers/README.md"),
    "utf8",
  );
  await appendFile(
    resolve(outputDirectory, "third-party-licenses.txt"),
    `\n\n${cssLicenses.join("\n\n")}\n\n${providerNotices.trim()}\n`,
  );

  if (metadata) {
    await cp(
      resolve(sourceDirectory, "social-preview.png"),
      resolve(outputDirectory, "social-preview.png"),
    );
    const indexPath = resolve(outputDirectory, "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace("</head>", `${metadata}\n  </head>`));
  }

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
    ...(process.env.EXGEN_PUBLIC_SITE_URL ? { publicUrl: process.env.EXGEN_PUBLIC_SITE_URL } : {}),
  });
  process.stdout.write(`Built results site: ${outputDirectory}\n`);
}
