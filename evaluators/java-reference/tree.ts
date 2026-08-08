import type { Token } from "../shared/java/lexer.ts";

/**
 * A bracket-structure tree over a Java token stream, and Zhang-Shasha tree edit distance over it.
 *
 * The tree is built from balanced `{}`, `()` and `[]` delimiters. Leaves are *normalised* labels:
 * every identifier becomes `ID` and every literal becomes `LIT`, so the tree describes shape rather
 * than naming. That is the intended division of labour between the two reference metrics:
 *
 *   - `reference.ast_edit_distance` compares shape, and is therefore blind to renaming;
 *   - `reference.codebleu` compares surface tokens, and is therefore sensitive to it.
 *
 * Reporting both is the point. One of them moving without the other says something specific about
 * how a candidate differs from its reference.
 */

export interface StructureNode {
  label: string;
  children: StructureNode[];
}

const MAXIMUM_NODES = 4_000;

function normaliseLabel(token: Token): string {
  switch (token.kind) {
    case "identifier":
      return "ID";
    case "number":
    case "string":
    case "character":
      return "LIT";
    default:
      return token.value;
  }
}

const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

export function structureTree(tokens: Token[]): StructureNode {
  const root: StructureNode = { label: "unit", children: [] };
  const stack: Array<{ node: StructureNode; closer: string }> = [{ node: root, closer: "" }];
  let nodes = 1;
  for (const token of tokens) {
    const current = stack.at(-1);
    if (current === undefined) {
      break;
    }
    if (nodes >= MAXIMUM_NODES) {
      break;
    }
    const closer = OPENERS[token.value];
    if (closer !== undefined) {
      const node: StructureNode = { label: `group${token.value}`, children: [] };
      current.node.children.push(node);
      stack.push({ node, closer });
      nodes += 1;
      continue;
    }
    if (token.value === current.closer && stack.length > 1) {
      stack.pop();
      continue;
    }
    current.node.children.push({ label: normaliseLabel(token), children: [] });
    nodes += 1;
  }
  return root;
}

export function treeSize(node: StructureNode): number {
  return 1 + node.children.reduce((total, child) => total + treeSize(child), 0);
}

interface PostorderTree {
  labels: string[];
  /** Index of the left-most leaf descendant of each node, in postorder. */
  leftmost: number[];
  keyroots: number[];
}

function postorder(root: StructureNode): PostorderTree {
  const labels: string[] = [];
  const leftmost: number[] = [];
  const visit = (node: StructureNode): number => {
    let firstLeaf = -1;
    for (const child of node.children) {
      const childLeaf = visit(child);
      if (firstLeaf === -1) {
        firstLeaf = childLeaf;
      }
    }
    const index = labels.length;
    labels.push(node.label);
    leftmost.push(firstLeaf === -1 ? index : firstLeaf);
    return leftmost[index] ?? index;
  };
  visit(root);
  const seen = new Set<number>();
  const keyroots: number[] = [];
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const leaf = leftmost[index] ?? index;
    if (!seen.has(leaf)) {
      seen.add(leaf);
      keyroots.push(index);
    }
  }
  return { labels, leftmost, keyroots: keyroots.reverse() };
}

/**
 * Zhang-Shasha ordered tree edit distance with unit insert, delete and relabel costs.
 *
 * Ordered rather than unordered on purpose: the order of statements in a method body is semantically
 * meaningful in Java, and the unordered variant is NP-hard anyway.
 */
export function treeEditDistance(left: StructureNode, right: StructureNode): number {
  const a = postorder(left);
  const b = postorder(right);
  const sizeA = a.labels.length;
  const sizeB = b.labels.length;
  // Both tables are flat: the index arithmetic is the algorithm's, and a flat buffer keeps it
  // visible instead of hiding it behind nested array bounds checks.
  const permanentStride = sizeB + 1;
  const permanent = new Float64Array((sizeA + 1) * permanentStride);
  const at = (table: Float64Array, index: number): number => table[index] ?? 0;

  for (const keyrootA of a.keyroots) {
    for (const keyrootB of b.keyroots) {
      const offsetA = a.leftmost[keyrootA] ?? 0;
      const offsetB = b.leftmost[keyrootB] ?? 0;
      const rows = keyrootA - offsetA + 2;
      const columns = keyrootB - offsetB + 2;
      const forest = new Float64Array(rows * columns);
      for (let row = 1; row < rows; row += 1) {
        forest[row * columns] = at(forest, (row - 1) * columns) + 1;
      }
      for (let column = 1; column < columns; column += 1) {
        forest[column] = at(forest, column - 1) + 1;
      }
      for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
          const nodeA = offsetA + row - 1;
          const nodeB = offsetB + column - 1;
          const deleteCost = at(forest, (row - 1) * columns + column) + 1;
          const insertCost = at(forest, row * columns + column - 1) + 1;
          const leftmostA = a.leftmost[nodeA] ?? 0;
          const leftmostB = b.leftmost[nodeB] ?? 0;
          if (leftmostA === offsetA && leftmostB === offsetB) {
            const relabel =
              at(forest, (row - 1) * columns + column - 1) +
              (a.labels[nodeA] === b.labels[nodeB] ? 0 : 1);
            const best = Math.min(deleteCost, insertCost, relabel);
            forest[row * columns + column] = best;
            permanent[(nodeA + 1) * permanentStride + nodeB + 1] = best;
          } else {
            const subForest =
              at(forest, (leftmostA - offsetA) * columns + (leftmostB - offsetB)) +
              at(permanent, (nodeA + 1) * permanentStride + nodeB + 1);
            forest[row * columns + column] = Math.min(deleteCost, insertCost, subForest);
          }
        }
      }
    }
  }
  return at(permanent, sizeA * permanentStride + sizeB);
}

/**
 * Tree edit distance normalised to [0, 1] by the sum of the two tree sizes, which is the largest
 * distance an edit script can cost. 0 is identical structure, 1 is nothing in common.
 */
export function normalisedTreeEditDistance(left: StructureNode, right: StructureNode): number {
  const total = treeSize(left) + treeSize(right);
  if (total === 0) {
    return 0;
  }
  return Math.min(1, treeEditDistance(left, right) / total);
}
