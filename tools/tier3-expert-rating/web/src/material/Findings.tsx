import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

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

type Findings = NonNullable<ExerciseView["findings"]>;

type Metric = Findings["metrics"][number];

function MetricList({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="m-0 grid max-w-full grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {metrics.map((metric) => (
        <div key={metric.label} className="contents">
          <dt className="text-muted-foreground">{metric.label}</dt>
          <dd className="m-0 font-medium">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The automatic findings of ExGen-Bench's tool-based checks, as reported and unfiltered. */
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
                <CircleCheckIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No findings</EmptyTitle>
              <EmptyDescription>
                No problems were reported by these checks. This does not establish that the exercise
                is correct.
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
            Test results
          </h3>
          <p className="m-0 text-sm text-muted-foreground">
            Coverage measures execution, not correctness. Change probes cover selected
            implementations.
          </p>
          <MetricList metrics={findings.metrics} />
        </section>
      )}
    </div>
  );
}
