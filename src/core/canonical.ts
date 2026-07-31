import { canonicalize } from "json-canonicalize";

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256(value: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

export function digestJson(value: unknown): string {
  return sha256(canonicalJson(value));
}
