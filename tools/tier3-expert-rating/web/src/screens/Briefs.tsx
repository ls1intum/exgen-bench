import { Markdown } from "../material/Markdown.tsx";
import { phaseLabel } from "../material/phase.ts";
import type { StepOf, StepProps } from "../step.ts";
import { SectionPage } from "./Questionnaire.tsx";

/**
 * The last step: the briefs of the rater’s assigned exercises, then the questions about them. The
 * briefs are short, so they stay open one below the other, where they can be compared.
 */
export function Briefs({ session, step, onSession, onError }: StepProps<StepOf<"briefs">>) {
  return (
    <SectionPage
      key={step.key}
      section={session.instrument.briefs}
      step={step}
      next="the end of the study"
      onSession={onSession}
      onError={onError}
    >
      <ol aria-label="Briefs" className="m-0 flex list-none flex-col gap-3 p-0">
        {step.briefs.map((brief) => (
          <li key={brief.number}>
            <section
              aria-labelledby={`brief-${brief.number}`}
              className="flex flex-col gap-2 rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 id={`brief-${brief.number}`} className="m-0 text-sm font-semibold">
                  Brief {brief.number} · {phaseLabel(brief.phase)}
                </h2>
              </div>
              <Markdown compact>{brief.brief}</Markdown>
            </section>
          </li>
        ))}
      </ol>
    </SectionPage>
  );
}
