import { digestJson, sha256 } from "../../../../src/core/canonical.ts";
import { type Exercise, withoutTestStatus } from "../../../tier3-expert-rating/shared/exercise.ts";
import { explainFindingMetric } from "../../../tier3-expert-rating/shared/finding-metrics.ts";
import {
  FINDINGS_PRESENTATION_VERSION,
  findingSections,
  unavailableMeasurements,
} from "../../../tier3-expert-rating/shared/findings-presentation.ts";
import {
  type Instrument,
  type Material,
  materialThrough,
  type PartId,
} from "../../../tier3-expert-rating/shared/instrument.ts";
import { groupStarterFiles } from "../../../tier3-expert-rating/shared/starter-files.ts";
import {
  STUDY_FINDING_GUIDANCE,
  STUDY_MATERIAL_CAPTION,
  STUDY_MATERIAL_LABEL,
  STUDY_TEST_COPY,
} from "../../../tier3-expert-rating/web/src/material/captions.ts";

/**
 * What one stage of the staged judge may see: the material the survey opens up to that part,
 * rendered as text the way the rating screen shows it, and nothing else. The projection reads only
 * the fields the survey displays; `facts`, the exercise ID, test `generic` flags and finding
 * `severity` never reach a prompt.
 *
 * The text mirrors the survey's components: `Markdown` (task rows, PlantUML diagrams), `Template`
 * with `groupStarterFiles`, `Diff`, `Tests` and `Findings` (via the shared findings presentation).
 * A change to what those show changes `TEXT_PRESENTATION_VERSION`.
 */
export const TEXT_PRESENTATION_VERSION = "staged-text-3";

export interface MaterialSection {
  material: Material;
  label: string;
  caption?: string;
  text: string;
}

export interface StageFile {
  path: string;
  content: string;
}

export interface StageMaterial {
  part: PartId;
  /** Open material in the survey's tab order. */
  materials: Material[];
  sections: MaterialSection[];
  /** Starter files in the closed "Build and setup files" group, readable on request. */
  setup: StageFile[];
  /** Every locator an answer may cite at this stage. */
  locators: LocatorCatalog;
  /** Paths left out because their content is binary; the survey shows none either. */
  omitted: string[];
  presentation: { text: string; findings: string };
  /** Digest of exactly what this stage makes available: sections and setup files. */
  evidenceSha256: string;
}

/** Stable, human-readable locators: what exists, and how many lines a lined locator has. */
export interface LocatorCatalog {
  names: Set<string>;
  lines: Map<string, number>;
}

const TASK = /\[task(:untested)?]\[([^[\]]+)]/g;

function numbered(text: string): string {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`).join("\n");
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/** Task markers as the survey's task rows: the title, and "No tests" for an untested task. */
function withTaskRows(statement: string): string {
  return statement.replace(TASK, (_match, untested: string | undefined, title: string) =>
    untested === undefined ? `[Task: ${title}]` : `[Task: ${title} · No tests]`,
  );
}

function taskTitles(statement: string): string[] {
  return [...statement.matchAll(TASK)].map((match) => match[2] ?? "").filter(Boolean);
}

function isBinary(content: string): boolean {
  return content.includes("\u0000");
}

function renderStatement(statement: string): string {
  const diagrams = (statement.match(/^```plantuml\s*$/gm) ?? []).length;
  const note =
    diagrams > 0
      ? `The statement contains ${diagrams} PlantUML diagram${diagrams === 1 ? "" : "s"}. ` +
        "Raters see each rendered as a diagram; here it appears as its PlantUML source, which " +
        "the survey renders without change.\n\n"
      : "";
  return `${note}Locator: statement:L<line>\n\n${numbered(withTaskRows(statement))}`;
}

function renderBrief(brief: string): string {
  return `Locator: brief:L<line>\n\n${numbered(brief)}`;
}

function renderTemplate(
  files: StageFile[],
  statement: string,
  changed: ReadonlySet<string>,
): { text: string; setup: StageFile[] } {
  if (files.length === 0) {
    return {
      text: "No starter files. Students start from an empty repository.",
      setup: [],
    };
  }
  const { main, setup } = groupStarterFiles(files, statement);
  const mark = (path: string) =>
    changed.has(path) ? " (M: the sample solution changes this file)" : "";
  const out: string[] = [];
  out.push("Locator: file:<path> or file:<path>:L<line>");
  out.push("");
  out.push("Files:");
  out.push(
    ...(main.length === 0 ? ["(none)"] : main.map((file) => `- ${file.path}${mark(file.path)}`)),
  );
  if (setup.length > 0) {
    out.push("");
    out.push(`Build and setup files (${setup.length}), closed by default:`);
    out.push(...setup.map((file) => `- ${file.path}${mark(file.path)}`));
    if (main.length === 0) {
      out.push("All starter files are build and setup files, so this group opens by default.");
    }
  }
  // An all-setup tree opens its setup group, as the survey does; otherwise setup stays closed.
  const opened = main.length === 0 ? setup : main;
  for (const file of opened) {
    out.push("");
    out.push(`=== file: ${file.path} (${lineCount(file.content)} lines) ===`);
    out.push(numbered(file.content));
  }
  return { text: out.join("\n"), setup: main.length === 0 ? [] : setup };
}

function renderDiff(diff: Exercise["diff"]): string {
  if (diff.length === 0) {
    return "The solution changes no file. The sample solution matches the starter code.";
  }
  const out: string[] = [
    "Locator: diff:<path> or diff:<path>:L<line>, with the line number of the sample solution " +
      "(or of the starter code for a removed line).",
  ];
  for (const file of diff) {
    const all = file.hunks.flatMap((hunk) => hunk.lines);
    const added = all.filter((line) => line.kind === "added").length;
    const removed = all.filter((line) => line.kind === "removed").length;
    out.push("");
    out.push(`=== diff: ${file.path} (${file.change}, +${added} −${removed}) ===`);
    out.push("starter code | solution | change | line");
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
        out.push(
          `${String(line.old ?? "").padStart(4)} | ${String(line.new ?? "").padStart(4)} | ${sign} | ${line.text}`,
        );
      }
    }
  }
  return out.join("\n");
}

type TestGroup = Exercise["tests"][number];
type Test = TestGroup["tests"][number];

function message(text: string): string {
  return text === "" ? "No message" : text;
}

function renderTests(groups: Exercise["tests"]): string {
  if (groups.length === 0) {
    return `${STUDY_TEST_COPY.emptyTitle}. ${STUDY_TEST_COPY.emptyDescription}`;
  }
  const out: string[] = [
    "Locator: test:<name> or task:<task title>",
    "",
    STUDY_TEST_COPY.messageSource,
  ];
  for (const group of groups) {
    const tests = group.tests;
    const first = tests[0];
    const shared =
      tests.length > 1 &&
      first !== undefined &&
      tests.every(
        (test) =>
          test.passed !== true && test.message === first.message && test.variant === undefined,
      )
        ? first.message
        : undefined;
    out.push("");
    out.push(
      `${group.task === null ? "Not linked to a task" : `Task: ${group.task}`} · ` +
        `${tests.length} ${tests.length === 1 ? "test" : "tests"}`,
    );
    if (group.task === null) {
      out.push(
        "No task in the problem statement names these tests. Some may check supplied code or " +
          "structure without awarding points.",
      );
    }
    if (shared !== undefined) {
      out.push(
        `All ${tests.length} tests fail on the ${STUDY_TEST_COPY.code} with the same message:`,
      );
      out.push(indent(message(shared)));
    }
    for (const test of tests) {
      out.push(...renderTest(test, shared === undefined));
    }
  }
  return out.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** One test row: an unrecorded outcome reads as failing, as the survey shows it. */
function renderTest(test: Test, showMessage: boolean): string[] {
  const passes = test.passed === true;
  const outcome = `${passes ? "passes" : "fails"} on the ${STUDY_TEST_COPY.code}`;
  const lines = [`- test: ${test.name} · ${outcome}`];
  if (test.variant !== undefined) {
    lines.push(`  ${STUDY_TEST_COPY.changedSolution}`);
  }
  if (showMessage && (!passes || test.variant !== undefined)) {
    lines.push(indent(message(test.message)));
  }
  if (test.variant !== undefined) {
    lines.push(`  ${STUDY_TEST_COPY.changeLabel} ${test.variant}`);
  }
  return lines;
}

function renderFindings(findings: Exercise["findings"]): string {
  const out: string[] = ["Locator: finding:<ID> or measurement:<label>", "", "Findings"];
  for (const section of findingSections(findings)) {
    const count = section.findings.length;
    out.push(
      `- ${section.label}: ${count === 0 ? "None reported" : `${count} finding${count === 1 ? "" : "s"}`}`,
    );
    for (const finding of section.findings) {
      out.push(`  - ${finding.source.id} · ${finding.title}`);
      if (finding.note !== undefined) out.push(`    ${finding.note}`);
    }
  }
  out.push(
    findings.items.length === 0
      ? "No automatic finding to review."
      : "Judge each finding against the exercise.",
  );
  out.push(STUDY_FINDING_GUIDANCE);
  if (findings.metrics.length === 0) {
    out.push("No measurements supplied.");
  } else if (unavailableMeasurements(findings)) {
    out.push("Some checks have no usable result; see details.");
  }
  out.push("");
  out.push("Evidence and measurements (collapsed in the survey, shown here in full):");
  if (findings.items.length > 0) {
    out.push("Evidence");
    for (const finding of findings.items) {
      out.push(`- ${finding.id} · ${finding.title}`);
      out.push(...finding.details.map((detail) => `  - ${detail}`));
    }
  }
  out.push("Measurements");
  if (findings.metrics.length === 0) {
    out.push("No measurements supplied.");
  } else {
    for (const metric of findings.metrics.map(explainFindingMetric)) {
      out.push(`- ${metric.label}: ${metric.value}`);
      if (metric.description !== undefined) out.push(`  ${metric.description}`);
    }
  }
  return out.join("\n");
}

/**
 * The material of one part. `materialThrough` decides what is open, so a change to the instrument's
 * release order changes the judge with it.
 */
export function stageMaterial(
  exercise: Exercise,
  instrument: Instrument,
  part: PartId,
): StageMaterial {
  const materials = materialThrough(instrument, part);
  const open = new Set(materials);
  // The study shows the task title before showing which tasks have no tests.
  const statement = open.has("tests") ? exercise.statement : withoutTestStatus(exercise.statement);
  const names = new Set<string>();
  const lines = new Map<string, number>();
  const sections: MaterialSection[] = [];
  let setup: StageFile[] = [];
  const omitted = exercise.template
    .filter((file) => isBinary(file.content))
    .map((file) => file.path);
  const files = exercise.template.filter((file) => !isBinary(file.content));
  // Like the survey, the template marks files the solution changes only once the diff is open.
  const changed = new Set(
    open.has("diff")
      ? exercise.diff.filter((file) => file.change === "modified").map((file) => file.path)
      : [],
  );
  for (const material of materials) {
    names.add(`material:${material}`);
    let text: string;
    switch (material) {
      case "brief":
        text = renderBrief(exercise.brief);
        lines.set("brief", lineCount(exercise.brief));
        break;
      case "statement":
        text = renderStatement(statement);
        lines.set("statement", lineCount(statement));
        for (const title of taskTitles(statement)) names.add(`task:${title}`);
        break;
      case "template": {
        const rendered = renderTemplate(files, open.has("statement") ? statement : "", changed);
        text = rendered.text;
        setup = rendered.setup;
        for (const file of files) {
          names.add(`file:${file.path}`);
          lines.set(`file:${file.path}`, lineCount(file.content));
        }
        break;
      }
      case "diff":
        text = renderDiff(exercise.diff);
        for (const file of exercise.diff) {
          names.add(`diff:${file.path}`);
          const numbers = file.hunks.flatMap((hunk) =>
            hunk.lines.flatMap((line) => [line.new ?? 0, line.old ?? 0]),
          );
          lines.set(`diff:${file.path}`, Math.max(0, ...numbers));
        }
        break;
      case "tests":
        text = renderTests(exercise.tests);
        for (const group of exercise.tests) {
          if (group.task !== null) names.add(`task:${group.task}`);
          for (const test of group.tests) names.add(`test:${test.name}`);
        }
        break;
      case "findings":
        text = renderFindings(exercise.findings);
        for (const finding of exercise.findings.items) names.add(`finding:${finding.id}`);
        for (const metric of exercise.findings.metrics.map(explainFindingMetric)) {
          names.add(`measurement:${metric.label}`);
        }
        break;
    }
    const caption = STUDY_MATERIAL_CAPTION[material];
    sections.push({
      material,
      label: STUDY_MATERIAL_LABEL[material],
      ...(caption === undefined ? {} : { caption }),
      text,
    });
  }
  const presentation = { text: TEXT_PRESENTATION_VERSION, findings: FINDINGS_PRESENTATION_VERSION };
  return {
    part,
    materials,
    sections,
    setup,
    locators: { names, lines },
    omitted,
    presentation,
    evidenceSha256: digestJson({
      presentation,
      sections,
      setup: setup.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
    }),
  };
}

const LINED = /^(statement|brief):L(\d+)(?:-L(\d+))?$/;
const PATH_LINED = /^((?:file|diff):.+?):L(\d+)(?:-L(\d+))?$/;

/** Why a locator is not valid at this stage, or null when it names something the stage shows. */
export function locatorProblem(locator: string, catalog: LocatorCatalog): string | null {
  const lined = LINED.exec(locator) ?? PATH_LINED.exec(locator);
  if (lined !== null) {
    const key = lined[1] ?? "";
    const total = catalog.lines.get(key);
    if (total === undefined) return `${key} is not available at this stage`;
    const from = Number(lined[2]);
    const to = lined[3] === undefined ? from : Number(lined[3]);
    if (from < 1 || to < from || to > total) {
      return `${locator} is outside ${key} (lines 1 to ${total})`;
    }
    return null;
  }
  if (catalog.names.has(locator)) return null;
  return `${locator} names nothing available at this stage`;
}
