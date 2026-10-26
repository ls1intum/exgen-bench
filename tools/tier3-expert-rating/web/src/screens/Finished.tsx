import { DownloadIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

import { calendarDate } from "../dates.ts";
import type { RaterSession } from "../step.ts";

/** The pages a session ends on, or waits on: done, declined, or waiting for an assignment. */
export function Finished({
  session,
  kind,
}: {
  session: RaterSession;
  kind: "waiting" | "done" | "declined";
}) {
  const contact = (
    <a className="text-primary underline" href={`mailto:${session.study.contact.email}`}>
      {session.study.contact.name}
    </a>
  );
  if (kind === "declined") {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="mt-0 mb-0 text-2xl font-semibold">You declined to take part</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Nothing else is stored. Questions go to {contact}.
        </p>
      </div>
    );
  }
  if (kind === "waiting") {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="mt-0 mb-0 text-2xl font-semibold">Your exercises are being prepared</h1>
        <p className="m-0 text-sm text-muted-foreground">
          You have completed the introduction and the practice exercise. As a reserve rater, you
          receive exercises from the study team only if they are needed. We will contact you; you
          can then continue with this link
          {session.rater.deadline !== null &&
            ` and should finish by ${calendarDate(session.rater.deadline)}`}
          .
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="mt-0 mb-0 text-2xl font-semibold">Thank you</h1>
      <p className="m-0 text-sm text-muted-foreground">
        Your answers are stored. Please do not discuss the exercises with anyone until we tell you
        that the study has closed. If you wish, download a copy of your answers. Questions go to{" "}
        {contact}.
      </p>
      <div className="flex gap-3">
        <a className={buttonVariants({ variant: "outline" })} href="/api/me/answers.json" download>
          <DownloadIcon aria-hidden="true" />
          Answers as JSON
        </a>
        <a className={buttonVariants({ variant: "outline" })} href="/api/me/answers.csv" download>
          <DownloadIcon aria-hidden="true" />
          Answers as CSV
        </a>
      </div>
    </div>
  );
}
