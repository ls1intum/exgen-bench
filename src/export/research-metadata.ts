import { EXGEN_VERSION } from "../version.ts";
import { ATTEMPT_COLUMNS, SCORE_COLUMNS } from "./tabular-contract.ts";

export interface ReleaseFile {
  path: string;
  sha256: string;
  bytes: number;
  media_type: string;
}

interface ResearchMetadataOptions {
  release: {
    title: string;
    description: string;
    license: string;
    url: string;
    creators: Array<{ name: string; orcid: string }>;
    createdAt: string;
    version: string;
  };
  generations: Array<{
    started_at?: string | null | undefined;
    finished_at?: string | null | undefined;
  }>;
}

function licenseUrl(license: string): string {
  try {
    return new URL(license).href;
  } catch {
    return `https://spdx.org/licenses/${encodeURIComponent(license)}.html`;
  }
}

export function croissantMetadata(options: ResearchMetadataOptions, files: ReleaseFile[]): unknown {
  const releaseBaseUrl = options.release.url.endsWith("/")
    ? options.release.url
    : `${options.release.url}/`;
  const distributions = files
    .filter((file) => file.path.startsWith("data/"))
    .map((file) => ({
      "@type": "cr:FileObject",
      "@id": file.path,
      name: file.path,
      contentUrl: new URL(file.path, releaseBaseUrl).href,
      contentSize: String(file.bytes),
      encodingFormat: file.media_type,
      sha256: file.sha256,
    }));
  const field = (
    recordSet: string,
    fileObject: string,
    name: string,
    dataType: string,
  ): unknown => ({
    "@type": "cr:Field",
    "@id": `${recordSet}/${name}`,
    name,
    dataType,
    source: {
      fileObject: { "@id": fileObject },
      extract: { column: name },
    },
  });
  return {
    "@context": {
      "@language": "en",
      "@vocab": "https://schema.org/",
      arrayShape: "cr:arrayShape",
      citeAs: "cr:citeAs",
      column: "cr:column",
      conformsTo: "dct:conformsTo",
      containedIn: "cr:containedIn",
      cr: "http://mlcommons.org/croissant/",
      rai: "http://mlcommons.org/croissant/RAI/",
      dct: "http://purl.org/dc/terms/",
      sc: "https://schema.org/",
      data: { "@id": "cr:data", "@type": "@json" },
      dataType: { "@id": "cr:dataType", "@type": "@vocab" },
      description: { "@container": "@language" },
      equivalentProperty: "cr:equivalentProperty",
      examples: { "@id": "cr:examples", "@type": "@json" },
      field: "cr:field",
      fileProperty: "cr:fileProperty",
      source: "cr:source",
      fileObject: "cr:fileObject",
      fileSet: "cr:fileSet",
      extract: "cr:extract",
      format: "cr:format",
      includes: "cr:includes",
      isArray: "cr:isArray",
      isLiveDataset: "cr:isLiveDataset",
      jsonPath: "cr:jsonPath",
      key: "cr:key",
      md5: "cr:md5",
      name: { "@container": "@language" },
      parentField: "cr:parentField",
      path: "cr:path",
      recordSet: "cr:recordSet",
      references: "cr:references",
      regex: "cr:regex",
      repeated: "cr:repeated",
      replace: "cr:replace",
      samplingRate: "cr:samplingRate",
      separator: "cr:separator",
      subField: "cr:subField",
      transform: "cr:transform",
    },
    "@type": "sc:Dataset",
    name: options.release.title,
    description: options.release.description,
    license: licenseUrl(options.release.license),
    url: options.release.url,
    creator: options.release.creators.map((creator) => ({
      "@type": "sc:Person",
      "@id": creator.orcid,
      name: creator.name,
    })),
    datePublished: options.release.createdAt,
    citeAs: `${options.release.creators.map((creator) => creator.name).join(", ")}. ${options.release.title} (${options.release.version}). ${options.release.url}`,
    version: options.release.version,
    conformsTo: "http://mlcommons.org/croissant/1.1",
    distribution: distributions,
    recordSet: [
      {
        "@type": "cr:RecordSet",
        "@id": "attempts",
        name: "attempts",
        description: "One record per planned generation attempt, including explicit missingness.",
        key: [{ "@id": "attempts/attempt_id" }],
        field: ATTEMPT_COLUMNS.map((column) =>
          field("attempts", "data/attempts.csv", column.name, column.croissantType),
        ),
      },
      {
        "@type": "cr:RecordSet",
        "@id": "scores",
        name: "scores",
        description: "Long-form evaluator scores with metric versions and denominators.",
        field: SCORE_COLUMNS.map((column) =>
          field("scores", "data/scores.csv", column.name, column.croissantType),
        ),
      },
    ],
  };
}

export function roCrateMetadata(options: ResearchMetadataOptions, files: ReleaseFile[]): unknown {
  const creators = options.release.creators.map((creator) => ({ "@id": creator.orcid }));
  const startedAt = options.generations
    .flatMap((observation) => (observation.started_at ? [observation.started_at] : []))
    .sort()[0];
  const finishedAt = options.generations
    .flatMap((observation) => (observation.finished_at ? [observation.finished_at] : []))
    .sort()
    .at(-1);
  return {
    "@context": "https://w3id.org/ro/crate/1.2/context",
    "@graph": [
      {
        "@id": "ro-crate-metadata.json",
        "@type": "CreativeWork",
        about: { "@id": "./" },
        conformsTo: { "@id": "https://w3id.org/ro/crate/1.2" },
      },
      {
        "@id": "./",
        "@type": "Dataset",
        name: options.release.title,
        description: options.release.description,
        identifier: options.release.url,
        version: options.release.version,
        datePublished: options.release.createdAt,
        license: { "@id": licenseUrl(options.release.license) },
        creator: creators,
        publisher: creators,
        mainEntity: { "@id": "release-manifest.json" },
        hasPart: files.map((file) => ({ "@id": file.path })),
      },
      ...options.release.creators.map((creator) => ({
        "@id": creator.orcid,
        "@type": "Person",
        name: creator.name,
      })),
      {
        "@id": "https://github.com/ls1intum/exgen-bench",
        "@type": "SoftwareApplication",
        name: "exgen-bench",
        version: EXGEN_VERSION,
        url: "https://github.com/ls1intum/exgen-bench",
      },
      {
        "@id": "#benchmark-run",
        "@type": "CreateAction",
        name: "Generate and evaluate programming exercises",
        ...(startedAt ? { startTime: startedAt } : {}),
        ...(finishedAt ? { endTime: finishedAt } : {}),
        instrument: { "@id": "https://github.com/ls1intum/exgen-bench" },
        object: [
          { "@id": "metadata/run-provenance.json" },
          { "@id": "metadata/cases.json" },
          { "@id": "metadata/systems.json" },
        ],
        result: [
          { "@id": "data/attempts.csv" },
          { "@id": "data/evaluations.jsonl" },
          { "@id": "data/scores.csv" },
        ],
      },
      {
        "@id": licenseUrl(options.release.license),
        "@type": "CreativeWork",
        name: options.release.license,
      },
      ...files.map((file) => ({
        "@id": file.path,
        "@type": "File",
        encodingFormat: file.media_type,
        contentSize: String(file.bytes),
        sha256: file.sha256,
      })),
    ],
  };
}
