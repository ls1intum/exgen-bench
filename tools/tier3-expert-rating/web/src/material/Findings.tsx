import { InfoIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

import type { ExerciseView } from "../../../shared/exercise.ts";

type Findings = NonNullable<ExerciseView["findings"]>;

/** The automatic findings of ExGen-Bench's tool-based checks, as reported and unfiltered. */
export function Findings({ findings }: { findings: Findings }) {
  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertDescription>
          These findings come from automated, tool-based checks. They may be wrong or irrelevant,
          and judging that is part of this part. Results of language-model judges and comparisons
          with reference exercises are not shown.
        </AlertDescription>
      </Alert>
      <section aria-labelledby="findings-heading">
        <h3 id="findings-heading" className="mt-0 mb-2 text-sm font-semibold">
          Findings
        </h3>
        {findings.items.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">The checks reported no findings.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {findings.items.map((finding) => (
              <li key={finding.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {finding.severity === "warning" ? (
                    <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive" />
                  ) : (
                    <InfoIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                  <span className="font-mono text-xs text-muted-foreground">{finding.id}</span>
                  <Badge variant="secondary">{finding.category}</Badge>
                  <span className="text-sm font-medium">{finding.title}</span>
                </div>
                {finding.details.length > 0 && (
                  <ul className="mt-2 mb-0 flex list-disc flex-col gap-1 pl-5 text-sm break-words text-muted-foreground">
                    {finding.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {findings.metrics.length > 0 && (
        <section aria-labelledby="metrics-heading">
          <h3 id="metrics-heading" className="mt-0 mb-2 text-sm font-semibold">
            Metrics
          </h3>
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            {findings.metrics.map((metric) => (
              <div key={metric.label} className="contents">
                <dt className="text-muted-foreground">{metric.label}</dt>
                <dd className="m-0 font-medium">{metric.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
