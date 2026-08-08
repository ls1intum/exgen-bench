export interface AdjustedPValue<Label> {
  label: Label;
  p_value: number;
  adjusted_p_value: number;
}

/**
 * Holm-Bonferroni step-down adjustment.
 *
 * Returns adjusted p-values in the input order, enforcing the monotonicity the procedure requires so
 * that a family can be read off at any level rather than only at the one it was corrected for.
 */
export function holmAdjust<Label>(
  family: Array<{ label: Label; p_value: number }>,
): Array<AdjustedPValue<Label>> {
  for (const entry of family) {
    if (!(entry.p_value >= 0 && entry.p_value <= 1)) {
      throw new Error("Holm adjustment requires p-values in [0, 1]");
    }
  }
  const count = family.length;
  const order = family
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.p_value - right.entry.p_value);
  const adjusted = new Array<number>(count);
  let running = 0;
  order.forEach(({ entry, index }, rank) => {
    running = Math.max(running, Math.min(1, (count - rank) * entry.p_value));
    adjusted[index] = running;
  });
  return family.map((entry, index) => ({
    label: entry.label,
    p_value: entry.p_value,
    adjusted_p_value: adjusted[index] ?? 1,
  }));
}
