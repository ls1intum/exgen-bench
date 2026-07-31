import { appendFile, cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type HtmlTagDescriptor, type Plugin } from "vite";

const SITE_TITLE = "exgen-bench — Programming exercise generation benchmark";
const SITE_DESCRIPTION =
  "Evaluate systems that generate autograder-ready programming exercises from instructor briefs.";
const SOCIAL_IMAGE_ALT =
  "Frozen instructor briefs pass through generation-system adapters to produce traceable evaluation and releases.";

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

function metadataPlugin(publicUrl: string): Plugin {
  const url = publicSiteUrl(publicUrl);
  const preview = new URL("social-preview.png", url).toString();
  const tags: HtmlTagDescriptor[] = [
    { tag: "link", attrs: { rel: "canonical", href: url } },
    { tag: "meta", attrs: { property: "og:type", content: "website" } },
    { tag: "meta", attrs: { property: "og:site_name", content: "exgen-bench" } },
    { tag: "meta", attrs: { property: "og:title", content: SITE_TITLE } },
    { tag: "meta", attrs: { property: "og:description", content: SITE_DESCRIPTION } },
    { tag: "meta", attrs: { property: "og:url", content: url } },
    { tag: "meta", attrs: { property: "og:image", content: preview } },
    { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
    { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
    {
      tag: "meta",
      attrs: { property: "og:image:alt", content: SOCIAL_IMAGE_ALT },
    },
    { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
    { tag: "meta", attrs: { name: "twitter:title", content: SITE_TITLE } },
    { tag: "meta", attrs: { name: "twitter:description", content: SITE_DESCRIPTION } },
    { tag: "meta", attrs: { name: "twitter:image", content: preview } },
    {
      tag: "meta",
      attrs: { name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT },
    },
  ];
  return {
    name: "exgen-public-metadata",
    transformIndexHtml: {
      order: "post",
      handler: () => tags,
    },
  };
}

export async function buildStaticSite(options: {
  outputDirectory: string;
  includeDemoData?: boolean;
  publicUrl?: string;
  sourceDirectory?: string;
}): Promise<string> {
  const sourceDirectory = resolve(options.sourceDirectory ?? import.meta.dirname);
  const outputDirectory = resolve(options.outputDirectory);
  const metadata = options.publicUrl ? metadataPlugin(options.publicUrl) : undefined;

  await build({
    configFile: resolve(sourceDirectory, "vite.config.ts"),
    root: sourceDirectory,
    base: "./",
    publicDir: false,
    ...(metadata ? { plugins: [metadata] } : {}),
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
