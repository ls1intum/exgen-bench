import alibabaMark from "../assets/providers/alibabacloud.svg";
import anthropicMark from "../assets/providers/anthropic.svg";
import deepseekMark from "../assets/providers/deepseek.svg";
import googleMark from "../assets/providers/googlegemini.webp";
import metaMark from "../assets/providers/meta.svg";
import mistralMark from "../assets/providers/mistralai.png";
import type { PublicRelease } from "../contracts.ts";

interface Catalog {
  default_release_id: string;
  releases: Array<{
    id: string;
    manifest: string;
  }>;
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

export async function loadRelease(): Promise<{
  release: PublicRelease;
  releaseUrl: URL;
}> {
  const catalogUrl = new URL("./data/catalog.json", window.location.href);
  const catalog = await fetchJson<Catalog>(catalogUrl);
  const selectedReleaseId =
    new URLSearchParams(window.location.search).get("release") ?? catalog.default_release_id;
  const entry = catalog.releases.find((release) => release.id === selectedReleaseId);
  if (!entry) {
    throw new Error(`Unknown release: ${selectedReleaseId}`);
  }
  const releaseUrl = new URL(entry.manifest, catalogUrl);
  return {
    release: await fetchJson<PublicRelease>(releaseUrl),
    releaseUrl,
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
