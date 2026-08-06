export type ClaimKind =
  | "non_null_result"
  | "nullable_result"
  | "no_mutation"
  | "exception"
  | "ordering"
  | "immutability"
  | "empty_input";

export interface StatementClaim {
  kind: ClaimKind;
  detail: string | undefined;
  text: string;
}

export interface StatedLiteral {
  kind: "string" | "number";
  raw: string;
  value: string | number;
  text: string;
}

export interface StatementModel {
  apiMembers: string[];
  claims: StatementClaim[];
  literals: StatedLiteral[];
  unclassifiedNormativeUnits: string[];
}

const JAVA_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "throw",
  "throws",
  "super",
  "this",
  "synchronized",
  "assert",
  "instanceof",
  "do",
  "else",
  "case",
]);

const NORMATIVE_MODAL =
  /\b(?:must|must not|mustn't|shall|never|always|cannot|can't|may not|is required to|are required to|has to|have to|guaranteed)\b/i;

const CLAIM_PATTERNS: Array<{ kind: ClaimKind; pattern: RegExp }> = [
  {
    kind: "non_null_result",
    pattern:
      /\b(?:never|not|no)\b[^.]{0,60}?\b(?:returns?|returning|returned|result|contains?|containing|holds?|produces?|yields?)\b[^.]{0,60}?\bnull\b|\b(?:returns?|returned|result)\b[^.]{0,60}?\bnever\s+(?:be\s+)?null\b/i,
  },
  { kind: "nullable_result", pattern: /\breturns?\s+null\b|\bnull\s+is\s+returned\b/i },
  {
    kind: "no_mutation",
    pattern:
      /(?:never|not|without|neither|nor)\b[^.]{0,70}?\b(?:modif|mutat|alter|chang)|\b(?:leav\w*|remain\w*|stay\w*)\b[^.]{0,60}\b(?:unchanged|untouched|unaffected|intact)\b|\b(?:original|input|supplied|given|caller'?s?)\b[^.]{0,60}\b(?:unchanged|untouched|unaffected|not\s+modified)\b|\bdefensive\s+cop|\bcop(?:y|ies)\s+(?:of\s+)?the\s+(?:supplied|given|input|original)\b|\bwithout\s+influencing\b/i,
  },
  {
    kind: "ordering",
    pattern: /\bin\s+(?:the\s+)?order\b|\bordered\b|\bordering\b|\bsorted\b|\balphabetical/i,
  },
  {
    kind: "immutability",
    pattern: /\bimmutab|\bunmodifiable\b|\bread-?only\b|\bcannot\s+be\s+modified\b/i,
  },
  {
    kind: "empty_input",
    pattern:
      /(?<!non-)(?<!not )\bempty\b[^.]{0,60}\b(?:input|list|string|collection|array|map|set|script|text|source)\b|\b(?:input|list|string|collection|array|map|set|script|text|source)\b[^.]{0,60}\bis\s+empty\b|\bempty\s+input\b/i,
  },
];

// Framing sentences describe the exercise or its scaffolding rather than promising behaviour, so
// they are neither claims nor evidence that a claim was missed.
const FRAMING_UNIT =
  /\bthe template\b[^.]{0,40}\b(?:already\s+)?(?:contains?|provides?|includes?|has)\b|\bin this exercise\b|\bwe (?:work with|want|control|consider|are given)\b|\byour (?:job|task) is\b|\bthe provided tests\b|\byou are given\b/i;

const EXCEPTION_NAME = /\b([A-Z][A-Za-z0-9]*(?:Exception|Error))\b/g;

function stripFences(markdown: string): { prose: string; fenced: string[] } {
  const fenced: string[] = [];
  const prose = markdown.replace(
    /^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm,
    (_, __, body: string) => {
      fenced.push(body);
      return "\n";
    },
  );
  return { prose, fenced };
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`+([^`\n]+)`+/g)].map((match) => match[1] ?? "");
}

function normaliseUnitText(unit: string): string {
  return unit.replace(/[`*_]/g, "").replace(/­|‐|‑/g, "-").replace(/\s+/g, " ").trim();
}

export function statementUnits(prose: string): string[] {
  const withoutTables = prose
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*#{1,6}\s/.test(line))
    .join("\n");
  const withoutMarkers = withoutTables
    .replace(/<testid>\d+<\/testid>/g, "")
    .replace(/\[task]\[([^\]]*)]\s*\(([^)]*)\)/g, "$1.");

  const units: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const joined = paragraph.join(" ").trim();
    paragraph = [];
    if (joined === "") {
      return;
    }
    for (const sentence of joined.split(/(?<=[.!?])\s+(?=[A-Z`*_([])/)) {
      const trimmed = sentence.trim();
      if (trimmed !== "") {
        units.push(trimmed);
      }
    }
  };
  for (const line of withoutMarkers.split("\n")) {
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      flush();
      units.push(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim());
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return units.filter((unit) => unit !== "");
}

function withoutDiagramMarkup(source: string): string {
  return source
    .replace(/<color:[^>]*>/g, "")
    .replace(/<\/color>/g, "")
    .replace(/<testid>\d+<\/testid>/g, "");
}

function signatureSources(markdown: string, prose: string, fenced: string[]): string[] {
  const tableCells = markdown
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .flatMap((line) => line.split("|"));
  return [...fenced, ...tableCells, ...codeSpans(markdown), ...codeSpans(prose)].map(
    withoutDiagramMarkup,
  );
}

export function extractApiMembers(markdown: string): string[] {
  const { prose, fenced } = stripFences(markdown);
  const sources = signatureSources(markdown, prose, fenced);
  const members = new Set<string>();
  const types = new Set<string>();

  for (const source of sources) {
    for (const match of source.matchAll(
      /\b(?:class|interface|enum|record|@interface)\s+([A-Z][A-Za-z0-9_]*)/g,
    )) {
      const name = match[1];
      if (name !== undefined) {
        types.add(name);
      }
    }
  }
  for (const source of sources) {
    for (const match of source.matchAll(/\b([a-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = match[1];
      if (name !== undefined && !JAVA_KEYWORDS.has(name)) {
        members.add(name);
      }
    }
    for (const match of source.matchAll(
      /\bpublic\s+(?:static\s+)?(?:final\s+)?[\w.<>[\],]+\s+([a-z_][A-Za-z0-9_]*)\s*;/g,
    )) {
      const name = match[1];
      if (name !== undefined) {
        members.add(name);
      }
    }
  }
  for (const source of sources) {
    for (const declaration of source.matchAll(/\brecord\s+[A-Z]\w*\s*\(([^)]*)\)/g)) {
      let parameters = declaration[1] ?? "";
      while (/<[^<>]*>/.test(parameters)) {
        parameters = parameters.replace(/<[^<>]*>/g, "");
      }
      for (const parameter of parameters.split(",")) {
        const component = parameter.trim().match(/([a-z_]\w*)$/);
        if (component?.[1] !== undefined) {
          members.add(component[1]);
        }
      }
    }
  }
  for (const block of fenced) {
    for (const line of withoutDiagramMarkup(block).split("\n")) {
      const method = line.match(/^\s*[+#~-]\s*(?:<<\w+>>\s*)?([A-Za-z_]\w*)\s*\(/);
      if (method?.[1] !== undefined && !types.has(method[1])) {
        members.add(method[1]);
        continue;
      }
      const field = line.match(/^\s*[+#~-]\s*[\w.<>[\],]+\s+([a-z_]\w*)\s*$/);
      if (field?.[1] !== undefined) {
        members.add(field[1]);
      }
    }
  }
  for (const type of types) {
    members.delete(type.charAt(0).toLowerCase() + type.slice(1));
  }
  return [...new Set([...types, ...members])].sort();
}

function extractLiterals(units: string[]): StatedLiteral[] {
  const literals = new Map<string, StatedLiteral>();
  for (const unit of units) {
    const text = normaliseUnitText(unit);
    for (const match of unit.matchAll(/"([^"\n]{1,80})"/g)) {
      const raw = match[1];
      if (raw !== undefined && raw.trim() !== "" && !/^\\[a-zA-Z0-9]$/.test(raw)) {
        literals.set(`string|${raw}`, { kind: "string", raw, value: raw, text });
      }
    }
    for (const span of [
      ...codeSpans(unit),
      ...[...unit.matchAll(/\*\*([^*\n]{1,40})\*\*/g)].map((m) => m[1] ?? ""),
    ]) {
      const numeric = span.trim().match(/^-?\d+(?:\.\d+)?$/);
      if (numeric === null) {
        continue;
      }
      const value = Number(numeric[0]);
      literals.set(`number|${value}`, { kind: "number", raw: numeric[0], value, text });
    }
  }
  return [...literals.values()];
}

export function parseStatement(markdown: string): StatementModel {
  const { prose } = stripFences(markdown);
  const units = statementUnits(prose);
  const claims = new Map<string, StatementClaim>();
  const unclassified: string[] = [];

  const record = (key: string, claim: StatementClaim) => {
    const existing = claims.get(key);
    if (existing === undefined) {
      claims.set(key, claim);
      return;
    }
    if (NORMATIVE_MODAL.test(claim.text) && !NORMATIVE_MODAL.test(existing.text)) {
      claims.set(key, claim);
    }
  };

  for (const unit of units) {
    const text = normaliseUnitText(unit);
    if (FRAMING_UNIT.test(text)) {
      continue;
    }
    let classified = false;
    const fired = new Set<ClaimKind>();
    for (const { kind, pattern } of CLAIM_PATTERNS) {
      if (!pattern.test(text) || (kind === "nullable_result" && fired.has("non_null_result"))) {
        continue;
      }
      fired.add(kind);
      classified = true;
      record(`${kind}|`, { kind, detail: undefined, text });
    }
    EXCEPTION_NAME.lastIndex = 0;
    for (const match of text.matchAll(EXCEPTION_NAME)) {
      const type = match[1];
      if (type === undefined) {
        continue;
      }
      classified = true;
      record(`exception|${type}`, { kind: "exception", detail: type, text });
    }
    if (!classified && NORMATIVE_MODAL.test(text)) {
      unclassified.push(text);
    }
  }

  return {
    apiMembers: extractApiMembers(markdown),
    claims: [...claims.values()],
    literals: extractLiterals(units),
    unclassifiedNormativeUnits: unclassified,
  };
}
