export const APPROACH_COLORS = [
  "#5eead4",
  "#a78bfa",
  "#fbbf24",
  "#fb7185",
  "#7dd3fc",
  "#bef264",
  "#fdba74",
  "#f0abfc",
  "#67e8f9",
] as const;

const NAMED_APPROACH_COLOR_INDEX = new Map([
  ["direct", 0],
  ["plan + review", 1],
]);

const NAMED_APPROACH_SYMBOL_INDEX = new Map([
  ["direct", 0],
  ["plan + review", 1],
]);

function stableIndex(value: string, length: number): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % length;
}

export function assignApproachColors(approaches: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    [...new Set(approaches)].sort().map((approach) => {
      const index =
        NAMED_APPROACH_COLOR_INDEX.get(approach.trim().toLowerCase()) ??
        stableIndex(approach, APPROACH_COLORS.length);
      return [approach, APPROACH_COLORS[index] ?? APPROACH_COLORS[0]];
    }),
  );
}

export function assignApproachSymbolIndices(
  colors: ReadonlyMap<string, string>,
  symbolCount: number,
): ReadonlyMap<string, number> {
  if (!Number.isInteger(symbolCount) || symbolCount < 1) {
    throw new Error("symbolCount must be a positive integer");
  }
  const usedCombinations = new Set<string>();
  return new Map(
    [...colors]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([approach, color]) => {
        const preferred =
          NAMED_APPROACH_SYMBOL_INDEX.get(approach.trim().toLowerCase()) ??
          stableIndex(`${approach}:symbol`, symbolCount);
        let index = preferred;
        for (let offset = 0; offset < symbolCount; offset += 1) {
          const candidate = (preferred + offset) % symbolCount;
          if (!usedCombinations.has(`${color}:${candidate}`)) {
            index = candidate;
            break;
          }
        }
        usedCombinations.add(`${color}:${index}`);
        return [approach, index];
      }),
  );
}
