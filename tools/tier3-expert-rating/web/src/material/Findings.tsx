import { InfoIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemGroup } from "@/components/ui/item";

import type { ExerciseView } from "../../../shared/exercise.ts";
import { explainFindingMetric } from "../../../shared/finding-metrics.ts";

type Findings = NonNullable<ExerciseView["findings"]>;

type Metric = Findings["metrics"][number];

function MetricList({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="m-0 flex flex-col gap-4 text-sm">
      {metrics.map(explainFindingMetric).map((metric) => (
        <div
          key={metric.label}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1"
        >
          <dt className="font-medium">{metric.label}</dt>
          <dd className="m-0 font-semibold tabular-nums">{metric.value}</dd>
          {metric.description && (
            <dd className="col-span-2 m-0 text-muted-foreground">{metric.description}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** The automatic findings of ExGen-Bench's tool-based checks, with source evidence and explicit measurement scope. */
export function Findings({ findings }: { findings: Findings }) {
  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertDescription>
          Check each finding against the exercise. The checks can miss problems or report an
          irrelevant issue.
        </AlertDescription>
      </Alert>
      <section aria-labelledby="findings-heading" className="flex flex-col gap-2">
        <h3 id="findings-heading" className="m-0 text-sm font-semibold">
          Findings
        </h3>
        {findings.items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InfoIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No issue detected by these checks</EmptyTitle>
              <EmptyDescription>
                Review the exercise yourself. Full coverage and rejected code changes do not rule
                out other problems.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {findings.items.map((finding) => (
              <Item key={finding.id} variant="outline" role="listitem">
                <ItemContent>
                  <div className="flex items-start gap-2 text-sm font-medium">
                    {finding.severity === "warning" ? (
                      <TriangleAlertIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-destructive"
                      />
                    ) : (
                      <InfoIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="mt-px shrink-0 font-mono text-xs text-muted-foreground">
                      {finding.id}
                    </span>
                    <span className="sr-only">
                      {finding.severity === "warning" ? ", warning" : ", note"}:
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {finding.title}
                      <Badge variant="secondary">{finding.category}</Badge>
                    </span>
                  </div>
                  {finding.details.length > 0 && (
                    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm break-words text-muted-foreground">
                      {finding.details.slice(0, 2).map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  )}
                  {finding.details.length > 2 && (
                    <details className="text-sm text-muted-foreground">
                      <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                        Show {finding.details.length - 2} more details
                      </summary>
                      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 break-words">
                        {finding.details.slice(2).map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </section>
      {findings.metrics.length > 0 && (
        <section aria-labelledby="metrics-heading" className="flex flex-col gap-2">
          <h3 id="metrics-heading" className="m-0 text-sm font-semibold">
            What the tests checked
          </h3>
          <p className="m-0 text-sm text-muted-foreground">
            Measured on the sample solution. These results do not establish correctness.
          </p>
          <MetricList metrics={findings.metrics} />
        </section>
      )}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          What these checks cover
        </summary>
        <p className="mt-2">
          The checks measure execution of changed solution code, test selected code edits and report
          compiler warnings about generic types. They also check supported explicit stream and
          while-loop requirements and some code references. They do not verify every requirement,
          worked example or possible input.
        </p>
      </details>
    </div>
  );
}
