import type { ExerciseView } from "../../../shared/exercise.ts";
import type { Material } from "../../../shared/instrument.ts";
import { Diff } from "./Diff.tsx";
import { Findings } from "./Findings.tsx";
import { Markdown } from "./Markdown.tsx";
import { Template } from "./Template.tsx";
import { Tests } from "./Tests.tsx";

/**
 * One kind of an exercise's material, as raters see it. The rating screen and the study team's
 * preview both render material through this, so the preview shows exactly what raters see.
 * `onOpen` reports a template file the reader opened; the preview records nothing.
 */
export function MaterialContent({
  exercise,
  material,
  onOpen,
}: {
  exercise: ExerciseView;
  material: Material;
  onOpen: (path: string) => void;
}) {
  switch (material) {
    case "brief":
      return <Markdown>{exercise.brief ?? ""}</Markdown>;
    case "statement":
      return <Markdown>{exercise.statement ?? ""}</Markdown>;
    case "template":
      return (
        <Template
          files={exercise.template ?? []}
          changed={(exercise.diff ?? [])
            .filter((file) => file.change === "modified")
            .map((file) => file.path)}
          onOpen={onOpen}
        />
      );
    case "diff":
      return <Diff files={exercise.diff ?? []} />;
    case "tests":
      return <Tests groups={exercise.tests ?? []} />;
    case "findings":
      return exercise.findings === undefined ? null : <Findings findings={exercise.findings} />;
  }
}
