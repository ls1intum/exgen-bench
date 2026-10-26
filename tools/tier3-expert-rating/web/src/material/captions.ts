import type { Material } from "../../../shared/instrument.ts";

/** The tab label of each kind of material. */
export const MATERIAL_LABEL: Record<Material, string> = {
  brief: "Brief",
  statement: "Problem statement",
  template: "Template",
  diff: "Solution changes",
  tests: "Tests",
  findings: "Findings",
};

/** One line above each kind of material: what it is, and whose view it shows. */
export const MATERIAL_CAPTION: Record<Material, string> = {
  brief: "The request the exercise was generated from: topic, target level, and course phase.",
  statement: "The problem statement as students read it in Artemis, before their first submission.",
  template: "The repository students start from: the files they get and the stubs they fill in.",
  diff: "What a student has to add or change: the template (−) turned into the sample solution (+).",
  tests: "The tests a submission runs against, by task, with the message students see on failure.",
  findings: "What tool-based checks report about this exercise.",
};
