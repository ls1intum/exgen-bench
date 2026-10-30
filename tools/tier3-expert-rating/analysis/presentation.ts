/** A report is one presentation condition; observations are never silently dropped or pooled. */
export const PRESENTATION_POOLING_ERROR =
  "Cannot pool findings presentation conditions. Create separate documented analysis inputs for each condition and review mixed exposures separately.";

/** Missing metadata in an old export stays explicitly unversioned. */
export function singleFindingsPresentation(data: unknown): string | null {
  const rows = (data as { tables?: { ratings?: unknown } } | null)?.tables?.ratings;
  if (!Array.isArray(rows)) throw new Error("The survey export has no ratings table");
  const conditions = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row.complete !== true) continue;
    const observed = row.findings_presentations;
    if (
      observed != null &&
      typeof observed !== "string" &&
      !(Array.isArray(observed) && observed.every((value) => typeof value === "string"))
    )
      throw new Error("Invalid findings presentation provenance in a completed rating");
    if (
      row.findings_presentation_mixed != null &&
      typeof row.findings_presentation_mixed !== "boolean"
    )
      throw new Error("Invalid findings presentation provenance in a completed rating");
    const submitted = row.findings_presentation_at_submit;
    if (submitted != null && typeof submitted !== "string")
      throw new Error("Invalid findings presentation provenance in a completed rating");
    const seen = (
      typeof observed === "string" ? observed.split(";") : (observed ?? [])
    ) as string[];
    const versions = new Set(seen.map((value) => value.trim()).filter(Boolean));
    versions.add(
      typeof submitted === "string" && submitted.trim() ? submitted.trim() : "legacy-unversioned",
    );
    if (row.findings_presentation_mixed === true || versions.size > 1)
      throw new Error(PRESENTATION_POOLING_ERROR);
    conditions.add([...versions][0]!);
  }
  if (conditions.size > 1) throw new Error(PRESENTATION_POOLING_ERROR);
  return [...conditions][0] ?? null;
}
