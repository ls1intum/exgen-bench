import { CircleCheckIcon, DownloadIcon, HourglassIcon, MailIcon } from "lucide-react";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";

import { type RaterSession, stepHeading } from "../step.ts";

function Page({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted [&_svg]:size-5">
        {icon}
      </div>
      <h1 ref={stepHeading} tabIndex={-1} className="m-0 text-xl font-semibold outline-none">
        {title}
      </h1>
      <div className="flex max-w-prose flex-col gap-4 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

/** The pages a session ends on, or waits on: done, declined, or waiting for an assignment. */
export function Finished({
  session,
  kind,
}: {
  session: RaterSession;
  kind: "waiting" | "done" | "declined";
}) {
  const { contact } = session.study;
  const mail = (
    <a className="text-primary underline" href={`mailto:${contact.email}`}>
      {contact.name}
    </a>
  );
  if (kind === "declined") {
    return (
      <Page icon={<MailIcon aria-hidden="true" />} title="You declined to take part">
        <p className="m-0 text-muted-foreground">
          We recorded that you declined. For questions, contact {mail}.
        </p>
      </Page>
    );
  }
  if (kind === "waiting") {
    return (
      <Page icon={<HourglassIcon aria-hidden="true" />} title="No exercises for you yet">
        <p className="m-0 text-muted-foreground">
          Thank you for your answers so far; they are saved. The study team assigns your exercises
          when they are needed and will contact you. You can then continue with this link.
        </p>
      </Page>
    );
  }
  const exercises = session.progress.filter((segment) => segment.label.startsWith("Exercise"));
  return (
    <Page icon={<CircleCheckIcon aria-hidden="true" className="text-primary" />} title="Thank you">
      <p className="m-0">
        You rated {exercises.length} {exercises.length === 1 ? "exercise" : "exercises"}, and every
        answer is stored. Your ratings help us see how instructors judge generated exercises and how
        reliable the automatic findings are. We publish them only in anonymised form.
      </p>
      <p className="m-0 text-muted-foreground">
        Please do not discuss the exercises with anyone until we tell you that the study has closed.
        For questions, contact {mail}.
      </p>
      <div className="flex flex-col gap-3 border-t pt-6">
        <p className="m-0 text-muted-foreground">Download your answers:</p>
        <div className="flex flex-wrap gap-3">
          <a
            className={buttonVariants({ variant: "outline" })}
            href="/api/me/answers.json"
            download
          >
            <DownloadIcon aria-hidden="true" />
            Answers as JSON
          </a>
          <a className={buttonVariants({ variant: "outline" })} href="/api/me/answers.csv" download>
            <DownloadIcon aria-hidden="true" />
            Answers as CSV
          </a>
        </div>
      </div>
    </Page>
  );
}
