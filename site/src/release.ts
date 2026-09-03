import alibabaMark from "../assets/providers/alibabacloud.svg";
import anthropicMark from "../assets/providers/anthropic.svg";
import deepseekMark from "../assets/providers/deepseek.svg";
import googleMark from "../assets/providers/googlegemini.webp";
import metaMark from "../assets/providers/meta.svg";
import mistralMark from "../assets/providers/mistralai.png";
import type { PublicAttempt, PublicRelease, PublicScore } from "../contracts.ts";

export interface CatalogEntry {
  id: string;
  label: string;
  manifest: string;
  status: string;
}

interface Catalog {
  default_release_id: string;
  releases: CatalogEntry[];
}

export interface Provider {
  id: string;
  name: string;
  mark: string | null;
}

const PROVIDERS: Record<string, Provider> = {
  alibaba: { id: "alibaba", name: "Alibaba Cloud", mark: alibabaMark },
  anthropic: { id: "anthropic", name: "Anthropic", mark: anthropicMark },
  deepseek: { id: "deepseek", name: "DeepSeek", mark: deepseekMark },
  google: { id: "google", name: "Google", mark: googleMark },
  meta: { id: "meta", name: "Meta", mark: metaMark },
  mistral: { id: "mistral", name: "Mistral AI", mark: mistralMark },
};

export type PublicSystem = PublicRelease["systems"][number];
export type PublicCase = PublicRelease["cases"][number];

export interface Configuration {
  system: PublicSystem;
  model: string;
  approach: string;
  provider: Provider;
}

function stringFactor(system: PublicSystem, key: string): string | null {
  const value = system.factors[key];
  return value === undefined || value === null ? null : String(value);
}

export function configuration(system: PublicSystem): Configuration {
  const providerId = (stringFactor(system, "provider") ?? "other").trim().toLowerCase();
  return {
    system,
    model: stringFactor(system, "model") ?? system.name,
    approach: stringFactor(system, "approach") ?? "Unspecified",
    provider: PROVIDERS[providerId] ?? {
      id: providerId,
      name: stringFactor(system, "provider") ?? "Other",
      mark: null,
    },
  };
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${url.pathname} (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function fetchJsonLines<T>(url: URL): Promise<T[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${url.pathname} (${response.status})`);
  }
  return (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export interface LoadedRelease {
  release: PublicRelease;
  releaseUrl: URL;
  catalog: CatalogEntry[];
  selectedReleaseId: string;
  attempts: PublicAttempt[];
  scores: PublicScore[];
}

export async function loadRelease(): Promise<LoadedRelease> {
  const catalogUrl = new URL("./data/catalog.json", window.location.href);
  const catalog = await fetchJson<Catalog>(catalogUrl);
  const selectedReleaseId =
    new URLSearchParams(window.location.search).get("release") ?? catalog.default_release_id;
  const entry = catalog.releases.find((release) => release.id === selectedReleaseId);
  if (!entry) {
    throw new Error(`Unknown release: ${selectedReleaseId}`);
  }
  const releaseUrl = new URL(entry.manifest, catalogUrl);
  const release = await fetchJson<PublicRelease>(releaseUrl);
  const needsRows = release.systems.length === 1 || release.evaluations !== undefined;
  const [attempts, scores] = await Promise.all([
    needsRows
      ? fetchJsonLines<PublicAttempt>(new URL("./attempts.jsonl", releaseUrl))
      : Promise.resolve([]),
    release.evaluations
      ? fetchJsonLines<PublicScore>(new URL("./scores.jsonl", releaseUrl))
      : Promise.resolve([]),
  ]);
  return {
    release,
    releaseUrl,
    catalog: catalog.releases,
    selectedReleaseId,
    attempts,
    scores,
  };
}

export function percent(value: number, digits = 0): string {
  return new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function dollars(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.1 ? 4 : 2,
  }).format(value);
}

export function seconds(value: number): string {
  return `${Math.round(value)}s`;
}

export function minutes(value: number): string {
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 60)} min`;
}

export function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function decimal(value: number, digits = 2): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(value);
}
