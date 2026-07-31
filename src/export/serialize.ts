import { stringify } from "csv-stringify/sync";
import { canonicalJson } from "../core/canonical.ts";

export function toJsonLines(values: unknown[]): string {
  return values.map((value) => canonicalJson(value)).join("\n") + (values.length > 0 ? "\n" : "");
}

export function toCsv(columns: string[], rows: object[]): string {
  return stringify(rows, {
    columns,
    header: true,
    record_delimiter: "unix",
    escape_formulas: true,
    cast: {
      boolean: (value) => (value ? "true" : "false"),
    },
  });
}
