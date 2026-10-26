import { LockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldGroup, FieldSeparator } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { PARTS } from "../../../shared/flow.ts";
import { type Item, MATERIAL, type Material, type Part } from "../../../shared/instrument.ts";
import { api } from "../api.ts";
import { describeAnswer } from "../items/describe.ts";
import { Inline, ItemField } from "../items/ItemField.tsx";
import { SubmitBar } from "../items/SubmitBar.tsx";
import { useAnswers } from "../items/useAnswers.ts";
import { Diff } from "../material/Diff.tsx";
import { Findings } from "../material/Findings.tsx";
import { Markdown } from "../material/Markdown.tsx";
import { Template } from "../material/Template.tsx";
import { Tests } from "../material/Tests.tsx";
import type { RaterSession, StepOf, StepProps } from "../step.ts";

const TAB_LABEL: Record<Material, string> = {
  brief: "Brief",
  statement: "Problem statement",
  template: "Template",
  diff: "Diff",
  tests: "Tests",
  findings: "Findings",
};

type RatingStep = StepOf<"calibration"> | StepOf<"part">;

function partOf(session: RaterSession, step: RatingStep): Part | undefined {
  return step.kind === "part"
    ? session.instrument.questionnaire.parts.find((part) => part.id === step.part)
    : undefined;
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

/** The size facts of the exercise header, verified automatically and not rated. */
function Facts({ exercise, step }: { exercise: ExerciseView; step: RatingStep }) {
  const { facts } = exercise;
  return (
    <div className="flex flex-col gap-1 border-b px-6 py-3 text-xs text-muted-foreground">
      <p className="m-0">
        <span className="font-mono font-medium text-foreground">{exercise.id}</span>
        {" · "}
        {exercise.phase} phase
        {step.kind === "part" && ` · exercise ${step.position} of ${step.total}`}
      </p>
      <p className="m-0">
        Verified automatically:{" "}
        {facts.gates_passed
          ? `compiles, the solution passes all ${count(facts.tests, "test")}, the template none`
          : "the build gates did not pass"}{" "}
        · {count(facts.tasks, "task")} · the student implements {count(facts.methods, "method")} in{" "}
        {count(facts.types, "type")}, about {count(facts.lines, "line")}
      </p>
    </div>
  );
}

function Material({
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
      return <Template files={exercise.template ?? []} onOpen={onOpen} />;
    case "diff":
      return <Diff files={exercise.diff ?? []} />;
    case "tests":
      return <Tests groups={exercise.tests ?? []} />;
    case "findings":
      return exercise.findings === undefined ? null : <Findings findings={exercise.findings} />;
  }
}

function MaterialPane({
  exercise,
  step,
  part,
  session,
}: {
  exercise: ExerciseView;
  step: RatingStep;
  part: Part | undefined;
  session: RaterSession;
}) {
  const open = MATERIAL.filter((material) => exercise[material] !== undefined);
  const shown = step.kind === "calibration" ? open : MATERIAL;
  const [tab, setTab] = useState<Material>(part?.material[0] ?? "statement");
  useEffect(() => {
    api.events(step.key, [{ type: "view", target: tab }]);
  }, [step.key, tab]);
  const opensIn = (material: Material) =>
    session.instrument.questionnaire.parts.find((candidate) =>
      candidate.material.includes(material),
    )?.id;
  return (
    <div className="flex min-h-0 flex-col">
      <Facts exercise={exercise} step={step} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Material)}>
        <div className="border-b px-6 pt-3">
          <TabsList variant="line">
            {shown.map((material) => (
              <TabsTrigger key={material} value={material} disabled={!open.includes(material)}>
                {!open.includes(material) && <LockIcon aria-hidden="true" />}
                {TAB_LABEL[material]}
                {!open.includes(material) && (
                  <span className="sr-only">, opens in Part {opensIn(material)}</span>
                )}
                {step.kind === "part" && step.part !== "A" && part?.material.includes(material) && (
                  <Badge variant="secondary">New</Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {open.map((material) => (
          <TabsContent key={material} value={material}>
            <div className="px-6 py-4">
              <Material
                exercise={exercise}
                material={material}
                onOpen={(path) => api.events(step.key, [{ type: "file", target: path }])}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function EarlierAnswers({ session, step }: { session: RaterSession; step: StepOf<"part"> }) {
  const earlier = PARTS.filter((part) => step.earlier[part] !== undefined);
  if (earlier.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="link" />}>
        Your answers to the earlier parts
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="m-0 flex flex-col gap-1 text-sm">
          {earlier.flatMap((partId) =>
            (
              session.instrument.questionnaire.parts.find((part) => part.id === partId)?.items ?? []
            ).map((item) => (
              <div key={item.id} className="flex gap-2">
                <dt className="font-mono text-xs text-muted-foreground">{item.id}</dt>
                <dd className="m-0">{describeAnswer(item, step.earlier[partId]?.[item.id])}</dd>
              </div>
            )),
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function nextLabel(session: RaterSession, step: RatingStep): string {
  if (step.kind === "calibration") return "our answers to the practice exercise, for comparison";
  const index = PARTS.indexOf(step.part);
  const following = session.instrument.questionnaire.parts[index + 1];
  if (following !== undefined) {
    return `Part ${following.id}, which adds ${following.material.map((material) => TAB_LABEL[material].toLowerCase()).join(" and ")}`;
  }
  return step.position < step.total ? "the next exercise" : "the final survey";
}

function Questions({
  session,
  step,
  items,
  part,
  onSession,
  onError,
}: StepProps<RatingStep> & { items: Item[]; part: Part | undefined }) {
  const form = useAnswers(step.key, items, step.draft);
  const { instrument } = session;
  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-4">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-lg font-semibold">
          {part === undefined ? instrument.calibration.title : `Part ${part.id}: ${part.title}`}
        </h1>
        <p className="m-0 text-sm text-muted-foreground">
          <Inline>{part?.opens ?? instrument.calibration.intro}</Inline>
        </p>
        <p className="m-0 text-sm text-muted-foreground">{instrument.questionnaire.perspective}</p>
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="link" />}>
            The materiality rule
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Markdown>{instrument.materiality_rule}</Markdown>
          </CollapsibleContent>
        </Collapsible>
        {step.kind === "part" && <EarlierAnswers session={session} step={step} />}
      </div>
      <FieldGroup>
        {items.map((item, index) => (
          <div key={item.id} className="flex flex-col gap-5">
            {index > 0 && <FieldSeparator />}
            <ItemField
              item={item}
              answer={form.answers[item.id]}
              onChange={(answer) => form.update(item.id, answer)}
              error={form.errors.get(item.id)}
            />
          </div>
        ))}
      </FieldGroup>
      <SubmitBar
        label={part === undefined ? "Submit the practice answers" : `Submit Part ${part.id}`}
        next={nextLabel(session, step)}
        save={form.save}
        issues={form.issues}
        onReveal={form.reveal}
        onSubmit={form.submit}
        onSession={onSession}
        onError={onError}
      />
    </div>
  );
}

/** Before an exercise's first part: what the four parts are, and room for a break. */
function ExerciseIntro({ session, step, onSession, onError }: StepProps<StepOf<"part">>) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-10">
      {step.position > 1 && (
        <p className="m-0 text-sm text-muted-foreground">
          Exercise {step.position - 1} is done and saved. Take a break if you like; you can close
          this page and continue later with your link.
        </p>
      )}
      <h1 className="m-0 text-2xl font-semibold">
        Exercise {step.position} of {step.total}
      </h1>
      <p className="m-0 text-sm">
        You rate the exercise in four parts, and each part adds material. Once you submit a part,
        you cannot return to it; if later material changes your view, use the remarks in Part D.
      </p>
      <ol className="m-0 flex flex-col gap-1 pl-5 text-sm">
        {session.instrument.questionnaire.parts.map((part) => (
          <li key={part.id}>
            Part {part.id}: {part.title}
          </li>
        ))}
      </ol>
      <div>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .open(step.key)
              .then(onSession, onError)
              .finally(() => setBusy(false));
          }}
        >
          Start Part A
        </Button>
      </div>
    </div>
  );
}

export function Rating(props: StepProps<RatingStep>) {
  const { session, step, onSession, onError } = props;
  const automatic = !step.opened && (step.kind === "calibration" || step.part !== "A");
  useEffect(() => {
    if (automatic) {
      api.open(step.key).then(onSession, onError);
    }
  }, [automatic, step.key, onSession, onError]);

  if (step.kind === "part" && !step.opened && step.part === "A") {
    return <ExerciseIntro {...props} step={step} />;
  }
  if (step.exercise === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const part = partOf(session, step);
  const items = part?.items ?? session.instrument.calibration.items;
  return (
    <div key={step.key} className="grid min-h-0 flex-1 grid-cols-5">
      <section aria-label="Material" className="col-span-3 min-h-0 overflow-y-auto border-r">
        <MaterialPane exercise={step.exercise} step={step} part={part} session={session} />
      </section>
      <section aria-label="Questions" className="col-span-2 flex min-h-0 flex-col">
        <Questions {...props} items={items} part={part} />
      </section>
    </div>
  );
}
