import { CircleHelpIcon, LockIcon } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { PARTS } from "../../../shared/flow.ts";
import { MATERIAL, type Material, type Part } from "../../../shared/instrument.ts";
import { api } from "../api.ts";
import { describeAnswer } from "../items/describe.ts";
import { ErrorSummary } from "../items/ErrorSummary.tsx";
import { Inline, ItemField } from "../items/ItemField.tsx";
import { SubmitBar } from "../items/SubmitBar.tsx";
import { useAnswers } from "../items/useAnswers.ts";
import { MATERIAL_CAPTION, MATERIAL_LABEL, MATERIAL_NOUN } from "../material/captions.ts";
import { Diff } from "../material/Diff.tsx";
import { Findings } from "../material/Findings.tsx";
import { Markdown } from "../material/Markdown.tsx";
import { phaseLabel } from "../material/phase.ts";
import { Template } from "../material/Template.tsx";
import { Tests } from "../material/Tests.tsx";
import { submitted } from "../progress.ts";
import { type RaterSession, stepHeading, type StepOf, type StepProps } from "../step.ts";
import { closeRule, type Pane, ratingTour, tourKey } from "../tour/ratingTour.ts";
import { useTour } from "../tour/useTour.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { ExerciseIntro } from "./ExerciseIntro.tsx";

type RatingStep = StepOf<"part">;
type Form = ReturnType<typeof useAnswers>;

function partOf(session: RaterSession, step: RatingStep): Part {
  const part = session.instrument.questionnaire.parts.find((part) => part.id === step.part);
  if (part === undefined) throw new Error(`the instrument has no Part ${step.part}`);
  return part;
}

/**
 * The exercise's identity above the material. The introduction already says what the automatic
 * checks confirmed for every exercise, so the header repeats none of it.
 */
function ExerciseHeader({ exercise, onTour }: { exercise: ExerciseView; onTour: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm font-semibold">{exercise.id}</span>
      <Badge variant="secondary">{phaseLabel(exercise.phase)}</Badge>
      <div className="ml-auto">
        <Button variant="ghost" size="xs" onClick={onTour}>
          <CircleHelpIcon aria-hidden="true" />
          Show the tour
        </Button>
      </div>
    </div>
  );
}

function MaterialContent({
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

/**
 * The material, one tab per kind. Material of later parts stays visible but locked, with the part
 * that opens it; material this part adds carries a dot.
 */
function MaterialPane({
  exercise,
  step,
  part,
  session,
  tab,
  onTab,
  onTour,
}: {
  exercise: ExerciseView;
  step: RatingStep;
  part: Part;
  session: RaterSession;
  tab: Material;
  onTab: (tab: Material) => void;
  onTour: () => void;
}) {
  const open = MATERIAL.filter((material) => exercise[material] !== undefined);
  // The tab bar scrolls in a narrow pane; the open tab must stay in view.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = list.current;
    if (element === null) return;
    // Centre the open tab in the bar, now and whenever the bar's size changes (a rotated phone,
    // a resized pane), measured from layout rather than scrolling the page.
    const reveal = () => {
      const active = element.querySelector<HTMLElement>("[data-active]");
      if (active === null) return;
      const bar = element.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      element.scrollLeft += box.left - bar.left - (bar.width - box.width) / 2;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tab]);
  const opensIn = (material: Material) =>
    session.instrument.questionnaire.parts.find((candidate) =>
      candidate.material.includes(material),
    )?.id;
  const fresh = (material: Material) => step.part !== "A" && part.material.includes(material);
  const content = open.map((material) => (
    <TabsContent key={material} value={material}>
      <div className="flex flex-col gap-4 px-6 py-5">
        {MATERIAL_CAPTION[material] !== undefined && (
          <p className="m-0 max-w-prose text-sm text-muted-foreground">
            {MATERIAL_CAPTION[material]}
          </p>
        )}
        <MaterialContent
          exercise={exercise}
          material={material}
          onOpen={(path) => api.events(step.key, [{ type: "file", target: path }])}
        />
      </div>
    </TabsContent>
  ));
  return (
    <Tabs value={tab} onValueChange={(value) => onTab(value as Material)}>
      <div className="@container flex min-w-0 flex-col">
        <div className="flex flex-col gap-3 border-b px-6 pt-4">
          <ExerciseHeader exercise={exercise} onTour={onTour} />
          <div ref={list} data-tour="tabs" className="-mb-px scroll-fade-x overflow-x-auto">
            <TabsList variant="line">
              {MATERIAL.map((material) => {
                const locked = !open.includes(material);
                // The visible label adapts to the pane; the accessible name says it all, always.
                const name = `${MATERIAL_LABEL[material]}${locked ? `, opens in Part ${opensIn(material)}` : ""}${fresh(material) ? ", new in this part" : ""}`;
                return (
                  <TabsTrigger
                    key={material}
                    value={material}
                    disabled={locked}
                    aria-label={name}
                    data-tour={`tab-${material}`}
                  >
                    {locked && <LockIcon aria-hidden="true" />}
                    {MATERIAL_LABEL[material]}
                    {locked && (
                      <span className="hidden text-xs font-normal text-muted-foreground @4xl:inline">
                        Part {opensIn(material)}
                      </span>
                    )}
                    {fresh(material) && <Badge variant="secondary">New</Badge>}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
        </div>
        {content}
      </div>
    </Tabs>
  );
}

/** A disclosure button in the question pane's header, flush with the text around it. */
function Disclosure({
  label,
  open,
  onToggle,
  controls,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <Button
      variant="link"
      size="sm"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      {open ? `Hide ${label.toLowerCase()}` : label}
    </Button>
  );
}

/** The item that asks for remarks on earlier answers; the earlier answers are shown before it. */
const REMARKS = "REM";

/**
 * What the rater answered in the earlier parts, question by question, right before the remarks on
 * them. Submitted parts cannot change, so this is read-only.
 */
function EarlierAnswers({ session, step }: { session: RaterSession; step: RatingStep }) {
  const parts = session.instrument.questionnaire.parts.filter(
    (part) => step.earlier[part.id] !== undefined,
  );
  const range =
    parts.length === 1
      ? `Part ${parts[0]?.id}`
      : `Parts ${parts[0]?.id} to ${parts[parts.length - 1]?.id}`;
  return (
    <section
      aria-labelledby="earlier-answers"
      className="flex flex-col gap-4 rounded-xl bg-muted/50 p-4 text-sm"
    >
      <h2 id="earlier-answers" className="m-0 text-sm font-semibold">
        Your answers in {range}
      </h2>
      {parts.map((part) => (
        <section
          key={part.id}
          aria-labelledby={`earlier-${part.id}`}
          className="flex flex-col gap-2"
        >
          <h3 id={`earlier-${part.id}`} className="m-0 text-xs font-semibold">
            Part {part.id} · {part.title}
          </h3>
          <dl className="m-0 flex flex-col gap-2">
            {part.items.map((item) => {
              const { answer, detail } = describeAnswer(item, step.earlier[part.id]?.[item.id]);
              return (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">
                    <span className="font-mono text-xs">{item.id}</span>{" "}
                    <Inline>{item.prompt}</Inline>
                  </dt>
                  <dd className="m-0 font-medium break-words">{answer}</dd>
                  {detail !== undefined && (
                    <dd className="m-0 break-words">
                      <span className="text-muted-foreground">{detail.label}: </span>
                      {detail.text}
                    </dd>
                  )}
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </section>
  );
}

function nextLabel(session: RaterSession, step: RatingStep): string {
  const index = PARTS.indexOf(step.part);
  const following = session.instrument.questionnaire.parts[index + 1];
  if (following !== undefined) {
    return `Part ${following.id}, which adds ${following.material.map((material) => MATERIAL_NOUN[material]).join(" and ")}`;
  }
  if (step.position < step.total) return "the next exercise";
  if (!submitted(session, "exit")) return "a few questions looking back on your exercises";
  return submitted(session, "briefs") ? "the end of the study" : "a last page on the briefs";
}

/** The questions of one part: what to read, the items as cards, and a footer that stays in view. */
function QuestionPane({
  session,
  step,
  part,
  form,
  onSession,
  onError,
}: StepProps<RatingStep> & {
  part: Part;
  form: Form;
}) {
  const { instrument } = session;
  const [rule, setRule] = useState(false);
  // Only the remarks on earlier answers, in Part D, show those answers; before it, they would
  // invite second-guessing parts that cannot change.
  const hasEarlier = PARTS.some((candidate) => step.earlier[candidate] !== undefined);
  const { items } = part;
  const body = (
    <div className="flex flex-col gap-5 px-6 py-5">
      <div className="flex flex-col gap-1.5">
        <div data-tour="part" className="flex flex-col gap-1.5">
          <h1 ref={stepHeading} tabIndex={-1} className="m-0 text-lg font-semibold outline-none">
            Part {part.id} · {part.title}
          </h1>
          <p className="m-0 max-w-prose text-sm text-muted-foreground">
            <Inline>{part.opens}</Inline>
          </p>
        </div>
        <div data-tour="rule" className="flex flex-col gap-1.5">
          <div className="-ml-2.5 flex flex-wrap items-center">
            <Disclosure
              label="The materiality rule"
              open={rule}
              onToggle={() => setRule(!rule)}
              controls="materiality-rule"
            />
          </div>
          {rule && (
            <div id="materiality-rule" className="rounded-lg bg-muted/50 p-3">
              <Markdown compact>{instrument.materiality_rule}</Markdown>
            </div>
          )}
        </div>
      </div>
      <ErrorSummary items={items} issues={form.issues} attempts={form.attempts} />
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.id === REMARKS && hasEarlier && <EarlierAnswers session={session} step={step} />}
            <ItemField
              item={item}
              answer={form.answers[item.id]}
              onChange={(answer) => form.update(item.id, answer)}
              error={form.errors.get(item.id)}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
  const footer = (
    <div data-tour="submit" className="sticky bottom-0 border-t bg-background px-6 py-3">
      <div>
        <SubmitBar
          label={`Submit Part ${part.id}`}
          next={nextLabel(session, step)}
          save={form.save}
          issues={form.issues}
          answered={form.answered}
          required={form.required}
          onReveal={form.reveal}
          onSubmit={form.submit}
          onSession={onSession}
          onError={onError}
        />
      </div>
    </div>
  );
  return (
    <div className="flex min-w-0 flex-col">
      {body}
      {footer}
    </div>
  );
}

/** Both panes share the page scroll; narrow screens show one pane at a time. */
function Workspace({
  wide,
  pane,
  setPane,
  material,
  questions,
  form,
}: {
  wide: boolean;
  /** The pane a narrow screen shows; the tour turns it to the pane of each of its stops. */
  pane: Pane;
  setPane: (pane: Pane) => void;
  material: () => ReactNode;
  questions: () => ReactNode;
  form: Form;
}) {
  // A failed submit shows what is missing, so a narrow screen turns to the questions.
  const [seen, setSeen] = useState(form.attempts);
  if (form.attempts !== seen) {
    setSeen(form.attempts);
    if (form.attempts > 0) setPane("questions");
  }
  const missing = form.attempts > 0 ? form.issues.length : 0;
  if (wide) {
    return (
      <div className="grid min-w-0 flex-1 grid-cols-12">
        <section aria-label="Material" className="col-span-7 min-w-0 border-r">
          {material()}
        </section>
        <section aria-label="Questions" data-tour="questions" className="col-span-5 min-w-0">
          {questions()}
        </section>
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1 scroll-pt-14">
      <Tabs value={pane} onValueChange={(value) => setPane(value as Pane)}>
        <div className="sticky top-0 z-10 border-b bg-background px-4 py-2">
          <TabsList>
            <TabsTrigger value="material">Material</TabsTrigger>
            <TabsTrigger value="questions">
              Questions ·{" "}
              {missing > 0 ? (
                <span className="text-destructive">{missing} missing</span>
              ) : (
                `${form.answered}/${form.required}`
              )}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="material" keepMounted>
          <section aria-label="Material">{material()}</section>
        </TabsContent>
        <TabsContent value="questions" keepMounted>
          <section aria-label="Questions">{questions()}</section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RatingWorkspace(props: StepProps<RatingStep> & { exercise: ExerciseView }) {
  const { session, step, exercise } = props;
  const part = partOf(session, step);
  // One form and one open tab for both layouts, so resizing the window loses neither.
  const form = useAnswers(step.key, part.items, step.draft);
  const [tab, setTab] = useState<Material>(part.material[0] ?? "statement");
  // Logged here, above both layouts, so switching layouts does not count as a view.
  useEffect(() => {
    api.events(step.key, [{ type: "view", target: tab }]);
  }, [step.key, tab]);
  const wide = useMediaQuery("(min-width: 64rem)");
  const [pane, setPane] = useState<Pane>("material");
  // The tour leaves the screen as it found it: the pane a narrow screen showed, and the rule closed
  // if the tour opened it. It never changes the material tab, which the events table records.
  const before = useRef<{ pane: Pane; rule: boolean }>({ pane, rule: false });
  const restore = useCallback(() => {
    if (before.current.rule) closeRule();
    setPane(before.current.pane);
  }, []);
  const tour = useTour({
    storageKey: tourKey(session),
    // The first exercise's Part A is where a rater meets this screen.
    auto: step.position === 1 && step.part === "A",
    // The tour's time counts toward the part it runs in; the events table records when it starts
    // and ends, so that the analysis can take it out.
    onStart: () => {
      before.current = { pane, rule: false };
      api.events(step.key, [{ type: "view", target: "tour" }]);
    },
    onEnd: () => {
      restore();
      api.events(step.key, [{ type: "view", target: "tour-end" }]);
    },
    stops: () =>
      ratingTour({
        session,
        part,
        open: MATERIAL.filter((material) => exercise[material] !== undefined),
        wide,
        showPane: setPane,
        onRuleOpened: () => {
          before.current.rule = true;
        },
      }),
  });
  // A window resized across the breakpoint swaps the layout under the tour, so it shows its stop
  // again in the new one.
  const { refresh } = tour;
  useEffect(() => refresh(), [wide, refresh]);
  return (
    <Workspace
      wide={wide}
      pane={pane}
      setPane={setPane}
      form={form}
      material={() => (
        <MaterialPane
          exercise={exercise}
          step={step}
          part={part}
          session={session}
          tab={tab}
          onTab={setTab}
          onTour={tour.start}
        />
      )}
      questions={() => <QuestionPane {...props} part={part} form={form} />}
    />
  );
}

export function Rating(props: StepProps<RatingStep>) {
  const { step, onSession, onError } = props;
  const automatic = !step.opened && step.part !== "A";
  useEffect(() => {
    if (automatic) {
      api.open(step.key).then(onSession, onError);
    }
  }, [automatic, step.key, onSession, onError]);

  if (!step.opened && step.part === "A") {
    return <ExerciseIntro {...props} step={step} />;
  }
  if (step.exercise === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <RatingWorkspace key={step.key} {...props} exercise={step.exercise} />;
}
