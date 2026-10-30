#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Instrument, Item } from "../shared/instrument.ts";
import { loadInstrument } from "./study.ts";

/**
 * INSTRUMENT.md: the instrument as a document, generated from instrument.yaml so the wording exists
 * once. `bun run survey:instrument` rewrites it; a test fails when the two differ.
 */

export const INSTRUMENT_DOCUMENT = resolve(import.meta.dir, "../INSTRUMENT.md");

function item(entry: Item): string {
  const lines = [`**${entry.id}.** ${entry.prompt}`];
  if (entry.kind !== "text" && "look_for" in entry && entry.look_for !== undefined) {
    lines.push(`*Look for:* ${entry.look_for}`);
  }
  if (entry.kind === "choice" && entry.note !== undefined) {
    lines.push(`*${entry.note}*`);
  }
  if (entry.kind === "text") {
    const required = entry.optional_when
      ? `required unless ${entry.optional_when.item} is ${entry.optional_when.value}`
      : entry.required
        ? "required"
        : "optional";
    lines.push(`Free text, ${required}.${entry.hint === undefined ? "" : ` ${entry.hint}`}`);
    return lines.join("\n\n");
  }
  const scale =
    entry.kind === "choice" && entry.scale !== undefined
      ? ` (1 = ${entry.scale.low}, ${entry.options.filter((option) => typeof option.value === "number").length} = ${entry.scale.high})`
      : "";
  lines.push(
    `${entry.kind === "multi" ? "Tick all that apply" : "Choose one"}${scale}:\n\n${entry.options
      .map((option) => {
        const detail =
          option.detail === undefined
            ? ""
            : ` → ${option.detail.choices === undefined ? "" : `${option.detail.choices.map((choice) => choice.label).join(" / ")}; `}${option.detail.label}${option.detail.required ? "" : " (optional)"}${option.detail.hint === undefined ? "" : `, hint: *${option.detail.hint}*`}`;
        const description = option.description === undefined ? "" : `: ${option.description}`;
        const exclusive = option.exclusive ? " (excludes the other options)" : "";
        return `- \`${option.value}\` ${option.label}${description}${exclusive}${detail}`;
      })
      .join("\n")}`,
  );
  return lines.join("\n\n");
}

export function instrumentDocument(instrument: Instrument): string {
  const sections = [
    `# ${instrument.title}: instrument\n\nVersion ${instrument.version}. Generated from [\`instrument.yaml\`](instrument.yaml) by \`bun run survey:instrument\`; edit the YAML, not this file.\n\nA rater first gives consent, in the wording of the study's \`study.yaml\`, and then sees the sections below in this order. The four parts of the rating repeat for every exercise assigned to the rater.`,
    `## Materiality rule\n\n> ${instrument.materiality_rule.trim()}`,
    `## ${instrument.onboarding.title}\n\n${instrument.onboarding.pages
      .map((page) => `### ${page.title}\n\n${page.body.trim()}`)
      .join("\n\n")}`,
    `## ${instrument.background.title}\n\n${instrument.background.intro}\n\n${instrument.background.items.map(item).join("\n\n")}`,
    `## ${instrument.questionnaire.title}\n\n${instrument.questionnaire.perspective}\n\n${instrument.questionnaire.parts
      .map(
        (part) =>
          `### Part ${part.id}: ${part.title}\n\nAbout ${part.minutes} minutes. *${part.opens}*\n\n${part.items.map(item).join("\n\n")}`,
      )
      .join("\n\n")}`,
    `## ${instrument.exit.title}\n\nAbout ${instrument.exit.minutes} minutes. ${instrument.exit.intro}\n\n${instrument.exit.items.map(item).join("\n\n")}`,
    `## ${instrument.briefs.title}\n\nAbout ${instrument.briefs.minutes} minutes. ${instrument.briefs.intro}\n\n*The page lists only the briefs of the rater’s assigned exercises, numbered to match their rating order.*\n\n${instrument.briefs.items.map(item).join("\n\n")}`,
  ];
  return `${sections.join("\n\n")}\n`;
}

if (import.meta.main) {
  await writeFile(INSTRUMENT_DOCUMENT, instrumentDocument(await loadInstrument()));
  // Through the formatter, so the committed file is the one `bun fmt --check` accepts.
  const formatter = Bun.spawn([process.execPath, "fmt", "--no-script", INSTRUMENT_DOCUMENT], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await formatter.exited) !== 0) {
    throw new Error("failed to format INSTRUMENT.md");
  }
}
