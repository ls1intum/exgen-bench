import { CheckIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import { type Answer, answerIssues, type Item, type Option } from "../../../shared/instrument.ts";

/** Instrument text with inline code and emphasis, as one line of a label or hint. */
export function Inline({ children }: { children: string }) {
  return (
    <ReactMarkdown
      allowedElements={["p", "code", "strong", "em"]}
      unwrapDisallowed
      components={{
        p: ({ children: content }) => <>{content}</>,
        code: ({ children: content }) => <code className="font-mono">{content}</code>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

/** An issue as a sentence that says what to do, for the rater rather than for the server log. */
export function issueSentence(item: Item | undefined, message: string): string {
  if (message === "is required") {
    return item?.kind === "text"
      ? "Write an answer."
      : item?.kind === "multi"
        ? "Choose at least one option."
        : "Choose an answer.";
  }
  const detail = /^needs “(.+)”$/.exec(message)?.[1];
  if (detail !== undefined) return `Fill in “${detail}”.`;
  if (message === "needs one of the follow-up choices") {
    return "Choose one of the follow-up options.";
  }
  if (message === "needs at least one option") return "Choose at least one option.";
  if (message === "combines an exclusive option with another") {
    return "Choose either this option or the others, not both.";
  }
  return `${message[0]?.toUpperCase()}${message.slice(1)}.`;
}

/** The anchor of an item, which the error summary links to. */
export const itemAnchor = (id: string) => `item-${id}`;

interface ItemFieldProps {
  item: Item;
  answer: Answer | undefined;
  onChange: (answer: Answer) => void;
  /** Why the answer cannot be submitted yet, once the rater has tried to submit. */
  error: string | undefined;
}

/**
 * Options that step outside the scale sit apart from it: N/A, and the words beside a numeric scale
 * such as "Cannot judge".
 */
function offScale(options: Option[]): (option: Option) => boolean {
  const numeric = options.some((option) => typeof option.value === "number");
  return (option) => option.value === "na" || (numeric && typeof option.value !== "number");
}

function optionTitle(item: Item, option: Option): string {
  return item.kind === "choice" && item.layout === "list" && typeof option.value === "number"
    ? `${option.value} · ${option.label}`
    : option.label;
}

/** One answer option as a card: the whole card is the target, not just the radio dot. */
function ChoiceCard({
  id,
  title,
  description,
  control,
}: {
  id: string;
  title: string;
  description?: string | undefined;
  control: React.ReactNode;
}) {
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        {control}
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          {description !== undefined && <FieldDescription>{description}</FieldDescription>}
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

/** The follow-up an option asks for, directly below the choice: a closed choice and a reason. */
function Detail({
  option,
  answer,
  onChange,
  focus,
}: {
  option: Option;
  answer: Answer;
  onChange: (answer: Answer) => void;
  /** Move the cursor here, because the rater just chose this option. */
  focus: boolean;
}) {
  const id = useId();
  const text = useRef<HTMLTextAreaElement>(null);
  const detail = option.detail;
  useEffect(() => {
    if (focus && detail?.choices === undefined) text.current?.focus();
  }, [focus, detail]);
  if (detail === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3 border-l-2 pl-4">
      {detail.choices !== undefined && (
        <RadioGroup
          aria-label={`${option.label}: follow-up`}
          value={answer.choice ?? null}
          onValueChange={(choice) => onChange({ ...answer, choice: choice as string })}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {detail.choices.map((choice) => (
              <ChoiceCard
                key={choice.value}
                id={`${id}-${choice.value}`}
                title={choice.label}
                control={<RadioGroupItem id={`${id}-${choice.value}`} value={choice.value} />}
              />
            ))}
          </div>
        </RadioGroup>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-text`}>
          {detail.label}
          {!detail.required && (
            <span className="font-normal text-muted-foreground">(optional)</span>
          )}
        </FieldLabel>
        <Textarea
          ref={text}
          id={`${id}-text`}
          value={answer.text ?? ""}
          maxLength={4000}
          placeholder={detail.hint}
          onChange={(event) => onChange({ ...answer, text: event.target.value })}
        />
      </Field>
    </div>
  );
}

/** The item code and whether the item is answered, in the card's top right corner. */
function Code({ item, answered }: { item: Item; answered: boolean }) {
  return (
    <span className="absolute top-4 right-4 flex items-center gap-1 font-mono text-xs text-muted-foreground">
      {answered && (
        <>
          <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
          <span className="sr-only">answered,</span>
        </>
      )}
      {item.id}
    </span>
  );
}

/** The question; the code stays part of the group's name for assistive technology and tests. */
function Legend({ item }: { item: Item }) {
  return (
    <FieldLegend>
      {/* Room for the code in the card's corner, on the question only. */}
      <span className="block pr-12 text-pretty">
        <span className="sr-only">{item.id}: </span>
        <Inline>{item.prompt}</Inline>
      </span>
    </FieldLegend>
  );
}

export function ItemField({ item, answer, onChange, error }: ItemFieldProps) {
  const id = useId();
  // The follow-up takes the focus after a click or tap only: arrow keys also change the value, and
  // moving the focus then would trap a keyboard user in the text field. A restored draft never does.
  const [chosen, setChosen] = useState(false);
  const pointer = useRef(false);
  const errorId = `${id}-error`;
  const invalid = error !== undefined;
  const answered = answer !== undefined && answerIssues([item], { [item.id]: answer }).length === 0;
  const hints = (
    <>
      {"look_for" in item && item.look_for !== undefined && (
        <FieldDescription>
          <span className="font-medium text-foreground">Look for: </span>
          <Inline>{item.look_for}</Inline>
        </FieldDescription>
      )}
      {"note" in item && item.note !== undefined && (
        <FieldDescription>
          <Inline>{item.note}</Inline>
        </FieldDescription>
      )}
    </>
  );
  const card = (content: React.ReactNode) => (
    // The card is the common region of one question; the error summary links to it.
    <div
      id={itemAnchor(item.id)}
      tabIndex={-1}
      data-invalid={invalid || undefined}
      className="relative scroll-mt-4 rounded-xl border bg-card p-4 outline-none focus:ring-3 focus:ring-ring/50 data-invalid:border-destructive/60"
    >
      <Code item={item} answered={answered} />
      {content}
    </div>
  );

  if (item.kind === "text") {
    return card(
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor={`${id}-text`}>
          <span className="pr-12">
            <span className="sr-only">{item.id}: </span>
            <Inline>{item.prompt}</Inline>
            {!item.required && (
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            )}
          </span>
        </FieldLabel>
        {item.hint !== undefined && <FieldDescription>{item.hint}</FieldDescription>}
        <Textarea
          id={`${id}-text`}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          value={answer?.text ?? ""}
          maxLength={4000}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        {invalid && (
          // The error summary announces the problem; a live region per field would repeat it.
          // oxlint-disable-next-line jsx-a11y/aria-role
          <FieldError id={errorId} role={undefined}>
            {issueSentence(item, error)}
          </FieldError>
        )}
      </Field>,
    );
  }

  if (item.kind === "multi") {
    const values = answer?.values ?? [];
    const toggle = (option: Option, checked: boolean) => {
      const value = option.value as string;
      const next = checked
        ? option.exclusive
          ? [value]
          : [
              ...values.filter(
                (selected) =>
                  !item.options.some(
                    (candidate) => candidate.exclusive && candidate.value === selected,
                  ),
              ),
              value,
            ]
        : values.filter((selected) => selected !== value);
      setChosen(checked);
      onChange({ ...answer, values: next });
    };
    const withDetail = item.options.find(
      (option) => option.detail !== undefined && values.includes(option.value as string),
    );
    return card(
      <FieldSet data-invalid={invalid || undefined}>
        <Legend item={item} />
        <FieldDescription>Tick all that apply.</FieldDescription>
        <div className="grid gap-2 sm:grid-cols-2">
          {item.options.map((option) => (
            <ChoiceCard
              key={String(option.value)}
              id={`${id}-${option.value}`}
              title={option.label}
              description={option.description}
              control={
                <Checkbox
                  id={`${id}-${option.value}`}
                  checked={values.includes(option.value as string)}
                  aria-invalid={invalid || undefined}
                  onCheckedChange={(checked) => toggle(option, checked)}
                />
              }
            />
          ))}
        </div>
        {withDetail !== undefined && (
          <Detail option={withDetail} answer={answer ?? {}} onChange={onChange} focus={chosen} />
        )}
        {invalid && (
          // The error summary announces the problem; a live region per field would repeat it.
          // oxlint-disable-next-line jsx-a11y/aria-role
          <FieldError id={errorId} role={undefined}>
            {issueSentence(item, error)}
          </FieldError>
        )}
      </FieldSet>,
    );
  }

  const selected = item.options.find((option) => option.value === answer?.value);
  const onValue = (raw: unknown) => {
    const option = item.options.find((candidate) => String(candidate.value) === String(raw));
    if (option !== undefined) {
      setChosen(pointer.current);
      pointer.current = false;
      onChange({
        value: option.value,
        ...(option.detail !== undefined && answer?.text !== undefined ? { text: answer.text } : {}),
        ...(option.detail?.choices !== undefined && answer?.choice !== undefined
          ? { choice: answer.choice }
          : {}),
      });
    }
  };
  const radio = (option: Option) => (
    <ChoiceCard
      key={String(option.value)}
      id={`${id}-${option.value}`}
      title={optionTitle(item, option)}
      description={item.layout === "inline" ? undefined : option.description}
      control={<RadioGroupItem id={`${id}-${option.value}`} value={String(option.value)} />}
    />
  );
  const outside = offScale(item.options);
  const onScale = item.options.filter((option) => !outside(option));
  const offScaleOptions = item.options.filter(outside);
  // Off-scale options follow the scale after a divider, so the scale's middle stays its middle.
  const apart = offScaleOptions.length > 0 && (
    <div className="flex flex-wrap gap-2 border-t pt-2">{offScaleOptions.map(radio)}</div>
  );
  const options =
    item.layout === "list" ? (
      <div className="flex flex-col gap-2">
        {onScale.map(radio)}
        {apart}
      </div>
    ) : item.layout === "scale" ? (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-5 gap-2">{onScale.map(radio)}</div>
        {item.scale !== undefined && (
          <div className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span>1 = {item.scale.low}</span>
            <span className="text-right">
              {onScale.length} = {item.scale.high}
            </span>
          </div>
        )}
        {apart}
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        {onScale.length <= 2 ? (
          <div className="grid grid-cols-2 gap-2">{onScale.map(radio)}</div>
        ) : (
          // More than two worded options stack in their order, as radios usually do.
          <div className="flex flex-col gap-2">{onScale.map(radio)}</div>
        )}
        {apart}
      </div>
    );
  return card(
    <FieldSet data-invalid={invalid || undefined}>
      <Legend item={item} />
      {hints}
      <RadioGroup
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        value={selected === undefined ? null : String(selected.value)}
        onValueChange={onValue}
        onPointerDown={() => {
          pointer.current = true;
        }}
      >
        {options}
      </RadioGroup>
      {selected !== undefined && answer !== undefined && (
        <Detail option={selected} answer={answer} onChange={onChange} focus={chosen} />
      )}
      {invalid && (
        // The error summary announces the problem; a live region per field would repeat it.
        // oxlint-disable-next-line jsx-a11y/aria-role
        <FieldError id={errorId} role={undefined}>
          {issueSentence(item, error)}
        </FieldError>
      )}
    </FieldSet>,
  );
}
