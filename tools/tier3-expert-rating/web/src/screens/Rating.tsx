import { CheckIcon, LockIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { PARTS } from "../../../shared/flow.ts";
import { type Item, MATERIAL, type Material, type Part } from "../../../shared/instrument.ts";
import { api } from "../api.ts";
import { describeAnswer } from "../items/describe.ts";
import { ErrorSummary } from "../items/ErrorSummary.tsx";
import { Inline, ItemField } from "../items/ItemField.tsx";
import { SubmitBar } from "../items/SubmitBar.tsx";
import { useAnswers } from "../items/useAnswers.ts";
import { MATERIAL_CAPTION, MATERIAL_LABEL } from "../material/captions.ts";
import { Diff } from "../material/Diff.tsx";
import { Findings } from "../material/Findings.tsx";
import { Markdown } from "../material/Markdown.tsx";
import { Template } from "../material/Template.tsx";
import { Tests } from "../material/Tests.tsx";
import type { RaterSession, StepOf, StepProps } from "../step.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { ExerciseIntro } from "./ExerciseIntro.tsx";

type RatingStep = StepOf<"calibration"> | StepOf<"part">;
type Form = ReturnType<typeof useAnswers>;

function partOf(session: RaterSession, step: RatingStep): Part | undefined {
  return step.kind === "part"
    ? session.instrument.questionnaire.parts.find((part) => part.id === step.part)
    : undefined;
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

/**
 * The exercise's identity and what the build verified, as compact facts above the material. They
 * are checked automatically and not rated, so they stay quiet.
 */
function Facts({ exercise }: { exercise: ExerciseView }) {
  const { facts } = exercise;
  const phase = `${exercise.phase[0]?.toUpperCase()}${exercise.phase.slice(1)} phase`;
  const checked = (text: string) => (
    <span className="inline-flex items-center gap-1">
      <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
      {text}
    </span>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{exercise.id}</span>
        <Badge variant="secondary">{phase}</Badge>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <span className="sr-only">Checked automatically:</span>
        {checked("Compiles")}
        {checked(`Solution passes all ${count(facts.tests, "test")}`)}
        <span>Template passes none, as intended</span>
        <span>{count(facts.tasks, "task")}</span>
        <span>
          Student writes ~{count(facts.lines, "line")} in {count(facts.methods, "method")}
        </span>
      </p>
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
  scroll,
  tab,
  onTab,
}: {
  exercise: ExerciseView;
  step: RatingStep;
  part: Part | undefined;
  session: RaterSession;
  scroll: boolean;
  tab: Material;
  onTab: (tab: Material) => void;
}) {
  const open = MATERIAL.filter((material) => exercise[material] !== undefined);
  const shown = step.kind === "calibration" ? open : MATERIAL;
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
  const fresh = (material: Material) =>
    step.kind === "part" && step.part !== "A" && part?.material.includes(material) === true;
  const content = open.map((material) => (
    <TabsContent key={material} value={material}>
      <div className="flex flex-col gap-4 px-6 py-5">
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {MATERIAL_CAPTION[material]}
        </p>
        <MaterialContent
          exercise={exercise}
          material={material}
          onOpen={(path) => api.events(step.key, [{ type: "file", target: path }])}
        />
      </div>
    </TabsContent>
  ));
  return (
    <Tabs
      className="h-full min-h-0"
      value={tab}
      onValueChange={(value) => onTab(value as Material)}
    >
      <div className="@container flex h-full min-h-0 flex-col">
        <div className="flex flex-col gap-3 border-b px-6 pt-4">
          <Facts exercise={exercise} />
          <div ref={list} className="-mb-px scroll-fade-x overflow-x-auto">
            <TabsList variant="line">
              {shown.map((material) => {
                const locked = !open.includes(material);
                // The visible label adapts to the pane; the accessible name says it all, always.
                const name = `${MATERIAL_LABEL[material]}${locked ? `, opens in Part ${opensIn(material)}` : ""}${fresh(material) ? ", new in this part" : ""}`;
                return (
                  <TabsTrigger key={material} value={material} disabled={locked} aria-label={name}>
                    {locked && <LockIcon aria-hidden="true" />}
                    {material === "statement" ? (
                      <>
                        <span className="@3xl:hidden">Statement</span>
                        <span className="hidden @3xl:inline">{MATERIAL_LABEL[material]}</span>
                      </>
                    ) : (
                      MATERIAL_LABEL[material]
                    )}
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
        {scroll ? <ScrollArea className="min-h-0 flex-1">{content}</ScrollArea> : content}
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

function EarlierAnswers({ session, step }: { session: RaterSession; step: StepOf<"part"> }) {
  const earlier = PARTS.filter((part) => step.earlier[part] !== undefined);
  return (
    <dl className="m-0 flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3 text-sm">
      {earlier.flatMap((partId) =>
        (
          session.instrument.questionnaire.parts.find((part) => part.id === partId)?.items ?? []
        ).map((item) => (
          <div key={item.id} className="flex gap-3">
            <dt className="w-10 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
              {item.id}
            </dt>
            <dd className="m-0">{describeAnswer(item, step.earlier[partId]?.[item.id])}</dd>
          </div>
        )),
      )}
    </dl>
  );
}

function nextLabel(session: RaterSession, step: RatingStep): string {
  if (step.kind === "calibration") return "our answers to the practice exercise, for comparison";
  const index = PARTS.indexOf(step.part);
  const following = session.instrument.questionnaire.parts[index + 1];
  if (following !== undefined) {
    return `Part ${following.id}, which adds ${following.material.map((material) => MATERIAL_LABEL[material].toLowerCase()).join(" and ")}`;
  }
  return step.position < step.total ? "the next exercise" : "the final survey";
}

/** The questions of one part: what to read, the items as cards, and a footer that stays in view. */
function QuestionPane({
  session,
  step,
  items,
  part,
  form,
  scroll,
  onSession,
  onError,
}: StepProps<RatingStep> & {
  items: Item[];
  part: Part | undefined;
  form: Form;
  scroll: boolean;
}) {
  const { instrument } = session;
  const [shown, setShown] = useState<"rule" | "earlier" | null>(null);
  const toggle = (which: "rule" | "earlier") => setShown(shown === which ? null : which);
  const hasEarlier =
    step.kind === "part" && PARTS.some((candidate) => step.earlier[candidate] !== undefined);
  const body = (
    <div className="flex flex-col gap-5 px-6 py-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-lg font-semibold">
          {part === undefined ? instrument.calibration.title : `Part ${part.id} · ${part.title}`}
        </h1>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          <Inline>{part?.opens ?? instrument.calibration.intro}</Inline>
        </p>
        {part === undefined && (
          <p className="m-0 max-w-prose text-sm text-muted-foreground">
            {instrument.questionnaire.perspective}
          </p>
        )}
        <div className="-ml-2.5 flex flex-wrap items-center">
          <Disclosure
            label="The materiality rule"
            open={shown === "rule"}
            onToggle={() => toggle("rule")}
            controls="materiality-rule"
          />
          {hasEarlier && (
            <Disclosure
              label="Your earlier answers"
              open={shown === "earlier"}
              onToggle={() => toggle("earlier")}
              controls="earlier-answers"
            />
          )}
        </div>
        {shown === "rule" && (
          <div id="materiality-rule" className="rounded-lg bg-muted/50 p-3">
            <Markdown compact>{instrument.materiality_rule}</Markdown>
          </div>
        )}
        {shown === "earlier" && step.kind === "part" && (
          <div id="earlier-answers">
            <EarlierAnswers session={session} step={step} />
          </div>
        )}
      </div>
      <ErrorSummary items={items} issues={form.issues} attempts={form.attempts} />
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <ItemField
            key={item.id}
            item={item}
            answer={form.answers[item.id]}
            onChange={(answer) => form.update(item.id, answer)}
            error={form.errors.get(item.id)}
          />
        ))}
      </div>
    </div>
  );
  const footer = (
    <div className="sticky bottom-0 border-t bg-background px-6 py-3">
      <div>
        <SubmitBar
          label={part === undefined ? "Submit and compare" : `Submit Part ${part.id}`}
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
  return scroll ? (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">{body}</ScrollArea>
      {footer}
    </div>
  ) : (
    <div className="flex flex-col">
      {body}
      {footer}
    </div>
  );
}

/** Both panes side by side and resizable on a wide screen; one at a time on a narrow one. */
function Workspace({
  material,
  questions,
  form,
}: {
  material: (scroll: boolean) => ReactNode;
  questions: (scroll: boolean) => ReactNode;
  form: Form;
}) {
  const wide = useMediaQuery("(min-width: 64rem)");
  const [pane, setPane] = useState("material");
  // A failed submit shows what is missing, so a narrow screen turns to the questions.
  const [seen, setSeen] = useState(form.attempts);
  if (form.attempts !== seen) {
    setSeen(form.attempts);
    if (form.attempts > 0) setPane("questions");
  }
  const missing = form.attempts > 0 ? form.issues.length : 0;
  if (wide) {
    return (
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="58%" minSize="35%">
          <section aria-label="Material" className="h-full min-h-0">
            {material(true)}
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="42%" minSize={360} maxSize={736}>
          <section aria-label="Questions" className="h-full min-h-0">
            {questions(true)}
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }
  return (
    <div className="min-h-0 flex-1 scroll-pt-14 overflow-y-auto">
      <Tabs value={pane} onValueChange={(value) => setPane(value as string)}>
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
          <section aria-label="Material">{material(false)}</section>
        </TabsContent>
        <TabsContent value="questions" keepMounted>
          <section aria-label="Questions">{questions(false)}</section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RatingWorkspace(props: StepProps<RatingStep> & { exercise: ExerciseView }) {
  const { session, step, exercise } = props;
  const part = partOf(session, step);
  const items = part?.items ?? session.instrument.calibration.items;
  // One form and one open tab for both layouts, so resizing the window loses neither.
  const form = useAnswers(step.key, items, step.draft);
  const [tab, setTab] = useState<Material>(part?.material[0] ?? "statement");
  // Logged here, above both layouts, so switching layouts does not count as a view.
  useEffect(() => {
    api.events(step.key, [{ type: "view", target: tab }]);
  }, [step.key, tab]);
  return (
    <Workspace
      form={form}
      material={(scroll) => (
        <MaterialPane
          exercise={exercise}
          step={step}
          part={part}
          session={session}
          scroll={scroll}
          tab={tab}
          onTab={setTab}
        />
      )}
      questions={(scroll) => (
        <QuestionPane {...props} items={items} part={part} form={form} scroll={scroll} />
      )}
    />
  );
}

export function Rating(props: StepProps<RatingStep>) {
  const { step, onSession, onError } = props;
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
  return <RatingWorkspace key={step.key} {...props} exercise={step.exercise} />;
}
