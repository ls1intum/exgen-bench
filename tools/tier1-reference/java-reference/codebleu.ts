import { JAVA_KEYWORDS, type Token, tokenizeJava } from "../../kit/java/lexer.ts";
import { type StructureNode, structureTree, treeSize } from "./tree.ts";

/**
 * CodeBLEU (Ren et al., 2020) adapted to the analysis this repository can actually perform.
 *
 * The original is a weighted sum of four components: n-gram BLEU, keyword-weighted n-gram BLEU,
 * syntactic AST subtree match, and semantic data-flow match. This is a variant, not a
 * reimplementation, and it differs in all four:
 *
 * - **n-gram BLEU** matches the reference implementation, except for the zero-precision floor,
 *   which is a length-dependent value rather than NLTK's `method1` epsilon.
 * - **keyword-weighted n-gram** weights an n-gram containing any keyword, at every order; the
 *   original weights each keyword *token*, at order one only, and by 5 rather than 4.
 * - **syntactic match** compares a node label with its immediate children's labels over a
 *   bracket-nesting tree; the original compares whole subtree s-expressions over a parsed AST.
 * - **data-flow** is replaced by a **variable-usage match**, because a data-flow graph needs the
 *   name resolution `shared/java/` deliberately stops short of.
 *
 * `components` reports every term separately, so a reader can see which one moved. Comparing a
 * score from here against a published CodeBLEU figure compares different quantities.
 */

export interface CodeBleuWeights {
  ngram: number;
  weightedNgram: number;
  syntax: number;
  variableUsage: number;
}

export const DEFAULT_CODEBLEU_WEIGHTS: CodeBleuWeights = {
  ngram: 0.25,
  weightedNgram: 0.25,
  syntax: 0.25,
  variableUsage: 0.25,
};

export interface CodeBleuResult {
  score: number;
  components: {
    ngram_match: number;
    weighted_ngram_match: number;
    syntax_match: number;
    variable_usage_match: number;
  };
  weights: CodeBleuWeights;
  candidate_tokens: number;
  reference_tokens: number;
}

const MAXIMUM_NGRAM = 4;
const KEYWORD_WEIGHT = 4;

function counts<Key>(items: Key[]): Map<Key, number> {
  const table = new Map<Key, number>();
  for (const item of items) {
    table.set(item, (table.get(item) ?? 0) + 1);
  }
  return table;
}

/**
 * N-gram multiset keyed by the JSON encoding of the token array. JSON is injective over string
 * arrays, so the key cannot collide whatever a token value contains, and the array stays available
 * to the weight function without being split back apart.
 */
function ngramCounts(
  values: string[],
  size: number,
): Map<string, { tokens: string[]; count: number }> {
  const table = new Map<string, { tokens: string[]; count: number }>();
  for (let index = 0; index + size <= values.length; index += 1) {
    const tokens = values.slice(index, index + size);
    const key = JSON.stringify(tokens);
    const entry = table.get(key);
    if (entry === undefined) {
      table.set(key, { tokens, count: 1 });
    } else {
      entry.count += 1;
    }
  }
  return table;
}

type NgramCounts = Map<string, { tokens: string[]; count: number }>;

function clippedPrecision(
  candidate: NgramCounts,
  reference: NgramCounts,
  weight: (ngram: string[]) => number,
): number | null {
  if (candidate.size === 0) {
    return null;
  }
  let matched = 0;
  let total = 0;
  for (const [key, { tokens, count }] of candidate) {
    const w = weight(tokens);
    total += count * w;
    matched += Math.min(count, reference.get(key)?.count ?? 0) * w;
  }
  return total === 0 ? null : matched / total;
}

/** Geometric mean of the clipped n-gram precisions with the standard brevity penalty. */
function bleu(
  candidate: string[],
  reference: string[],
  weight: (ngram: string[]) => number = () => 1,
): number {
  if (candidate.length === 0 || reference.length === 0) {
    return candidate.length === reference.length ? 1 : 0;
  }
  const precisions: number[] = [];
  for (let size = 1; size <= MAXIMUM_NGRAM; size += 1) {
    const precision = clippedPrecision(
      ngramCounts(candidate, size),
      ngramCounts(reference, size),
      weight,
    );
    if (precision === null) {
      continue;
    }
    // Smoothing: a zero precision at any order would zero the whole geometric mean, which is not
    // informative at the file sizes this benchmark compares.
    precisions.push(precision === 0 ? 1 / (2 * candidate.length) : precision);
  }
  if (precisions.length === 0) {
    return 0;
  }
  const logMean =
    precisions.reduce((total, precision) => total + Math.log(precision), 0) / precisions.length;
  const brevityPenalty =
    candidate.length >= reference.length ? 1 : Math.exp(1 - reference.length / candidate.length);
  return brevityPenalty * Math.exp(logMean);
}

function tokenValues(tokens: Token[]): string[] {
  return tokens.map((token) =>
    token.kind === "number" || token.kind === "string" || token.kind === "character"
      ? "LIT"
      : token.value,
  );
}

function subtrees(node: StructureNode, collected: string[] = []): string[] {
  if (node.children.length > 0) {
    collected.push(`${node.label}(${node.children.map((child) => child.label).join(",")})`);
  }
  for (const child of node.children) {
    subtrees(child, collected);
  }
  return collected;
}

function multisetMatch(candidate: string[], reference: string[]): number | null {
  if (candidate.length === 0 && reference.length === 0) {
    return null;
  }
  if (candidate.length === 0 || reference.length === 0) {
    return 0;
  }
  const referenceCounts = counts(reference);
  let matched = 0;
  for (const [key, count] of counts(candidate)) {
    matched += Math.min(count, referenceCounts.get(key) ?? 0);
  }
  return matched / Math.max(candidate.length, reference.length);
}

/**
 * For each identifier, the multiset of (previous token, next token) contexts it occurs in, with the
 * identifier itself abstracted away. Two implementations that use their variables the same way score
 * the same here even when every name differs.
 */
function variableUsageChains(tokens: Token[]): string[] {
  const chains: string[] = [];
  const aliases = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") {
      continue;
    }
    let alias = aliases.get(token.value);
    if (alias === undefined) {
      alias = `v${aliases.size}`;
      aliases.set(token.value, alias);
    }
    const before = tokens[index - 1]?.value ?? "^";
    const after = tokens[index + 1]?.value ?? "$";
    chains.push(`${alias}|${before}|${after}`);
  }
  return chains;
}

export function codeBleu(
  candidateSource: string,
  referenceSource: string,
  weights: CodeBleuWeights = DEFAULT_CODEBLEU_WEIGHTS,
): CodeBleuResult {
  const candidate = tokenizeJava(candidateSource).tokens;
  const reference = tokenizeJava(referenceSource).tokens;
  const candidateValues = tokenValues(candidate);
  const referenceValues = tokenValues(reference);

  const ngramMatch = bleu(candidateValues, referenceValues);
  const weightedNgramMatch = bleu(candidateValues, referenceValues, (ngram) =>
    ngram.some((value) => JAVA_KEYWORDS.has(value)) ? KEYWORD_WEIGHT : 1,
  );
  const candidateTree = structureTree(candidate);
  const referenceTree = structureTree(reference);
  const syntaxMatch =
    multisetMatch(subtrees(candidateTree), subtrees(referenceTree)) ??
    (treeSize(candidateTree) === treeSize(referenceTree) ? 1 : 0);
  const variableUsageMatch =
    multisetMatch(variableUsageChains(candidate), variableUsageChains(reference)) ?? 1;

  const total = weights.ngram + weights.weightedNgram + weights.syntax + weights.variableUsage;
  if (total <= 0) {
    throw new Error("CodeBLEU weights must sum to a positive number");
  }
  return {
    score:
      (weights.ngram * ngramMatch +
        weights.weightedNgram * weightedNgramMatch +
        weights.syntax * syntaxMatch +
        weights.variableUsage * variableUsageMatch) /
      total,
    components: {
      ngram_match: ngramMatch,
      weighted_ngram_match: weightedNgramMatch,
      syntax_match: syntaxMatch,
      variable_usage_match: variableUsageMatch,
    },
    weights,
    candidate_tokens: candidate.length,
    reference_tokens: reference.length,
  };
}
