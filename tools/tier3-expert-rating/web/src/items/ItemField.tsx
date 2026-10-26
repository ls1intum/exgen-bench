import { cn } from "cn";
import { useId } from "react";
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
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import type { Answer, Item, Option } from "../../../shared/instrument.ts";

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

interface ItemFieldProps {
  item: Item;
  answer: Answer | undefined;
  onChange: (answer: Answer) => void;
  /** Why the answer cannot be submitted yet, once the rater has tried to submit. */
  error: string | undefined;
}

function Detail({
  option,
  answer,
  onChange,
}: {
  option: Option;
  answer: Answer;
  onChange: (answer: Answer) => void;
}) {
  const id = useId();
  const detail = option.detail;
  if (detail === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3 pl-6">
      {detail.choices !== undefined && (
        <RadioGroup
          aria-label={`${option.label}: follow-up`}
          value={answer.choice ?? null}
          onValueChange={(choice) => onChange({ ...answer, choice: choice as string })}
        >
          {detail.choices.map((choice) => (
            <Field key={choice.value} orientation="horizontal">
              <RadioGroupItem id={`${id}-${choice.value}`} value={choice.value} />
              <FieldLabel htmlFor={`${id}-${choice.value}`}>{choice.label}</FieldLabel>
            </Field>
          ))}
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
          id={`${id}-text`}
          value={answer.text ?? ""}
          maxLength={4000}
          onChange={(event) => onChange({ ...answer, text: event.target.value })}
        />
      </Field>
    </div>
  );
}

export function ItemField({ item, answer, onChange, error }: ItemFieldProps) {
  const id = useId();
  const invalid = error !== undefined;
  const legend = (
    <FieldLegend>
      <span className="mr-2 font-mono text-xs text-muted-foreground">{item.id}</span>
      <Inline>{item.prompt}</Inline>
    </FieldLegend>
  );
  const hints = (
    <>
      {"look_for" in item && item.look_for !== undefined && (
        <FieldDescription>
          <span className="font-medium">Look for: </span>
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

  if (item.kind === "text") {
    return (
      <Field data-invalid={invalid || undefined}>
        <FieldLabel htmlFor={`${id}-text`}>
          <span className="mr-2 font-mono text-xs text-muted-foreground">{item.id}</span>
          <Inline>{item.prompt}</Inline>
          {!item.required && <span className="font-normal text-muted-foreground">(optional)</span>}
        </FieldLabel>
        {item.hint !== undefined && <FieldDescription>{item.hint}</FieldDescription>}
        <Textarea
          id={`${id}-text`}
          aria-invalid={invalid || undefined}
          value={answer?.text ?? ""}
          maxLength={4000}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        {invalid && <FieldError>{error}</FieldError>}
      </Field>
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
      onChange({ ...answer, values: next });
    };
    const withDetail = item.options.find(
      (option) => option.detail !== undefined && values.includes(option.value as string),
    );
    return (
      <FieldSet data-invalid={invalid || undefined}>
        {legend}
        <FieldDescription>Tick all that apply.</FieldDescription>
        <div className="flex flex-col gap-2">
          {item.options.map((option) => (
            <Field key={String(option.value)} orientation="horizontal">
              <Checkbox
                id={`${id}-${option.value}`}
                checked={values.includes(option.value as string)}
                aria-invalid={invalid || undefined}
                onCheckedChange={(checked) => toggle(option, checked)}
              />
              <FieldLabel htmlFor={`${id}-${option.value}`}>{option.label}</FieldLabel>
            </Field>
          ))}
        </div>
        {withDetail !== undefined && (
          <Detail option={withDetail} answer={answer ?? {}} onChange={onChange} />
        )}
        {invalid && <FieldError>{error}</FieldError>}
      </FieldSet>
    );
  }

  const selected = item.options.find((option) => option.value === answer?.value);
  const onValue = (raw: unknown) => {
    const option = item.options.find((candidate) => String(candidate.value) === String(raw));
    if (option !== undefined) {
      onChange({
        value: option.value,
        ...(option.detail !== undefined && answer?.text !== undefined ? { text: answer.text } : {}),
        ...(option.detail?.choices !== undefined && answer?.choice !== undefined
          ? { choice: answer.choice }
          : {}),
      });
    }
  };
  // On a scale, the end labels frame the levels; options such as "Cannot judge" follow them.
  const numeric = item.options.filter((option) => typeof option.value === "number");
  const others = item.options.filter((option) => typeof option.value !== "number");
  const choice = (option: Option) => (
    // A field fills its container; the wrapper keeps inline options as wide as their label.
    <div key={String(option.value)}>
      <Field orientation="horizontal">
        <RadioGroupItem id={`${id}-${option.value}`} value={String(option.value)} />
        <FieldContent>
          <FieldLabel htmlFor={`${id}-${option.value}`}>
            {item.layout === "list" && typeof option.value === "number"
              ? `${option.value}: ${option.label}`
              : option.label}
          </FieldLabel>
          {option.description !== undefined && (
            <FieldDescription>{option.description}</FieldDescription>
          )}
        </FieldContent>
      </Field>
    </div>
  );
  return (
    <FieldSet data-invalid={invalid || undefined}>
      {legend}
      {hints}
      <RadioGroup
        aria-invalid={invalid || undefined}
        value={selected === undefined ? null : String(selected.value)}
        onValueChange={onValue}
      >
        <div
          className={cn(
            "flex gap-3",
            item.layout === "list" ? "flex-col" : "flex-wrap items-center gap-x-6",
          )}
        >
          {item.layout === "scale" && item.scale !== undefined && (
            <span className="text-xs text-muted-foreground">1 = {item.scale.low}</span>
          )}
          {(item.layout === "scale" ? numeric : item.options).map(choice)}
          {item.layout === "scale" && item.scale !== undefined && (
            <span className="text-xs text-muted-foreground">
              {numeric.length} = {item.scale.high}
            </span>
          )}
          {item.layout === "scale" && others.map(choice)}
        </div>
      </RadioGroup>
      {selected !== undefined && answer !== undefined && (
        <Detail option={selected} answer={answer} onChange={onChange} />
      )}
      {invalid && <FieldError>{error}</FieldError>}
    </FieldSet>
  );
}
