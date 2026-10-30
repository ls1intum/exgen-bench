import type { ExerciseView } from "../../../shared/exercise.ts";
import { explainFindingMetric } from "../../../shared/finding-metrics.ts";
import { findingSections, unavailableMeasurements } from "../../../shared/findings-presentation.ts";

type Findings = NonNullable<ExerciseView["findings"]>;

/** A concise category report; evidence and measurements are available together on demand. */
export function Findings({ findings }: { findings: Findings }) {
  const sections = findingSections(findings);
  return (
    <section aria-label="Automatic findings report" className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby="findings-heading" className="flex min-w-0 flex-col gap-3">
        <h3 id="findings-heading" className="m-0 text-sm font-semibold">
          Findings
        </h3>
        <ul aria-label="Finding categories" className="m-0 flex list-none flex-col gap-2 p-0">
          {sections.map((section) => (
            <li key={section.id} className="min-w-0 rounded-lg border p-3 wrap-anywhere">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="m-0 text-sm font-semibold">{section.label}</h4>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {section.findings.length
                    ? `${section.findings.length} finding${section.findings.length === 1 ? "" : "s"}`
                    : "None reported"}
                </span>
              </div>
              {section.findings.length > 0 && (
                <ul className="mt-2 mb-0 flex list-none flex-col gap-3 p-0">
                  {section.findings.map((finding) => (
                    <li key={finding.source.id} className="flex min-w-0 items-start gap-2">
                      <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                        {finding.source.id}
                      </span>
                      <div className="min-w-0 text-sm">
                        <p className="m-0 font-medium">{finding.title}</p>
                        {finding.note && (
                          <p className="mt-1 mb-0 text-muted-foreground">{finding.note}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className="m-0 text-sm text-muted-foreground">
          {findings.items.length === 0
            ? "No automatic finding to review."
            : "Judge each finding against the exercise."}
        </p>
        {findings.metrics.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No measurements supplied.</p>
        ) : unavailableMeasurements(findings) ? (
          <p className="m-0 text-sm text-muted-foreground">
            Some checks have no usable result; see details.
          </p>
        ) : null}
      </section>
      <details className="min-w-0 text-sm wrap-anywhere">
        <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Evidence and measurements
        </summary>
        <div className="mt-4 flex min-w-0 flex-col gap-5">
          {findings.items.length > 0 && (
            <section aria-labelledby="evidence-heading" className="flex min-w-0 flex-col gap-4">
              <h4 id="evidence-heading" className="m-0 text-sm font-semibold">
                Evidence
              </h4>
              {findings.items.map((finding) => (
                <div key={finding.id} className="min-w-0">
                  <h5 className="m-0 text-sm font-medium">
                    {finding.id} · {finding.title}
                  </h5>
                  <ul className="mt-2 mb-0 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                    {finding.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
          <section aria-labelledby="measurements-heading" className="flex min-w-0 flex-col gap-3">
            <h4 id="measurements-heading" className="m-0 text-sm font-semibold">
              Measurements
            </h4>
            {findings.metrics.length === 0 ? (
              <p className="m-0 text-muted-foreground">No measurements supplied.</p>
            ) : (
              <dl className="m-0 flex flex-col gap-4">
                {findings.metrics.map(explainFindingMetric).map((metric) => (
                  <div
                    key={metric.label}
                    className="grid min-w-0 grid-cols-3 items-baseline gap-x-4 gap-y-1"
                  >
                    <dt className="col-span-2 font-medium">{metric.label}</dt>
                    <dd className="m-0 text-right font-semibold tabular-nums">{metric.value}</dd>
                    {metric.description && (
                      <dd className="col-span-3 m-0 text-muted-foreground">{metric.description}</dd>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </section>
          <p className="m-0 text-muted-foreground">
            “None reported” does not establish that a category was fully checked. The checks cover
            selected code and test properties, including supported stream and while-loop
            requirements. Cognitive demand, clarity, teaching value and other requirements need your
            judgement.
          </p>
        </div>
      </details>
    </section>
  );
}
