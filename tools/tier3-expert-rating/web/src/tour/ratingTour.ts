import type { Material, Part } from "../../../shared/instrument.ts";
import { itemAnchor } from "../items/ItemField.tsx";
import { MATERIAL_CAPTION, MATERIAL_NOUN } from "../material/captions.ts";
import type { RaterSession } from "../step.ts";
import type { TourStop } from "./useTour.ts";

/** Where the browser remembers that a rater saw the tour; the server keeps no record of it. */
export const tourKey = (session: RaterSession) => `exgen-survey:tour:${session.rater.id}`;

export type Pane = "material" | "questions";

const byTour = (name: string) => () => document.querySelector(`[data-tour="${name}"]`);

/** The materiality rule's disclosure, opened for its stop and closed again after the tour. */
const ruleButton = () =>
  document.querySelector<HTMLButtonElement>('[aria-controls="materiality-rule"]');

export function openRule(): boolean {
  const button = ruleButton();
  if (button === null || button.getAttribute("aria-expanded") === "true") return false;
  button.click();
  return true;
}

export function closeRule() {
  const button = ruleButton();
  if (button?.getAttribute("aria-expanded") === "true") button.click();
}

/**
 * The tour of the exercise screen: the questions first, then the material from the brief to what
 * later parts open, how to answer, and how a part ends. On a narrow screen, which shows the
 * material or the questions, each stop turns to the pane its target is in.
 */
export function ratingTour({
  session,
  part,
  open,
  wide,
  showPane,
  onRuleOpened,
}: {
  session: RaterSession;
  part: Part;
  /** The material this part shows; the rest is locked. */
  open: Material[];
  wide: boolean;
  showPane: (pane: Pane) => void;
  onRuleOpened: () => void;
}): TourStop[] {
  const inPane = (pane: Pane) => () => {
    if (!wide) showPane(pane);
  };
  const parts = session.instrument.questionnaire.parts;
  const later = parts
    .map((candidate) => ({
      id: candidate.id,
      locked: candidate.material.filter((material) => !open.includes(material)),
    }))
    .filter((candidate) => candidate.locked.length > 0)
    .map(
      (candidate) =>
        `${candidate.locked.map((material) => MATERIAL_NOUN[material]).join(" and ")} in Part ${candidate.id}`,
    );
  const asksWhere = part.items.flatMap((item) => {
    if (item.kind === "text") return [];
    const no = item.options.find((option) => option.value === "no");
    return no?.detail?.label === "Where" ? [{ id: item.id, hint: no.detail.hint }] : [];
  })[0];
  const stops: Array<TourStop | null> = [
    {
      target: wide ? byTour("questions") : byTour("part"),
      prepare: inPane("questions"),
      title: "Questions for this part",
      text: wide
        ? "Answer these questions about the exercise. Each part opens more material on the left and adds questions here."
        : "Answer these questions about the exercise. Each part opens more material and adds questions. Material and Questions at the top switch between them.",
      side: wide ? "left" : "bottom",
      align: "start",
    },
    open.includes("brief")
      ? {
          target: byTour("tab-brief"),
          prepare: inPane("material"),
          title: "The brief",
          text: `${MATERIAL_CAPTION.brief} Read it to see what the exercise should achieve.`,
          side: "bottom",
          align: "start",
        }
      : null,
    open.includes("statement")
      ? {
          target: byTour("tab-statement"),
          prepare: inPane("material"),
          title: "The problem statement",
          text: "What students read.",
          side: "bottom",
          align: "start",
        }
      : null,
    later.length > 0
      ? {
          target: byTour("tabs"),
          prepare: inPane("material"),
          title: "More material, part by part",
          text: `Locked tabs open in later parts: ${later.join(", ")}. Material you have seen stays open.`,
          side: "bottom",
          align: "start",
        }
      : null,
    {
      target: byTour("rule"),
      prepare: () => {
        inPane("questions")();
        if (openRule()) onRuleOpened();
      },
      title: "The materiality rule",
      text: "For borderline cases, this rule decides whether a problem counts. It is here whenever you are unsure.",
      side: wide ? "left" : "bottom",
      align: "start",
    },
    asksWhere === undefined
      ? null
      : {
          target: () => document.getElementById(itemAnchor(asksWhere.id)),
          prepare: inPane("questions"),
          title: "When you answer No",
          text: `If you answer No, a field asks where the problem is.${asksWhere.hint === undefined ? "" : ` ${asksWhere.hint}`}`,
          side: wide ? "left" : "top",
          align: "start",
        },
    {
      target: () => document.querySelector('nav[aria-label="Progress"]'),
      title: "Your progress",
      text: "Where you are in the study, part by part, and about how many minutes are left.",
      side: "bottom",
      align: "end",
    },
    {
      target: byTour("submit"),
      prepare: inPane("questions"),
      title: "Submit the part",
      text: `Once every question is answered, choose “Submit Part ${part.id}”. A submitted part cannot be changed. “Show the tour”, above the material, brings this tour back.`,
      side: "top",
      align: "end",
    },
  ];
  return stops.filter((stop): stop is TourStop => stop !== null);
}
