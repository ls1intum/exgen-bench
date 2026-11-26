import { useLayoutEffect, useRef } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { AnswerIssue, Item } from "../../../shared/instrument.ts";
import { Inline, itemAnchor } from "./ItemField.tsx";

function reveal(element: HTMLElement, block: ScrollLogicalPosition) {
  const pane = element.closest<HTMLElement>('[data-rating-questions-content][role="region"]');
  if (pane === null) {
    element.scrollIntoView({ block, behavior: "instant" });
  } else {
    const padding = Number.parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0;
    // Scroll only the questions. Scrolling the document can move the sticky pane at the same time.
    const offset = element.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    pane.scrollTo({ top: pane.scrollTop + offset - padding, behavior: "instant" });
  }
  element.focus({ preventScroll: true });
}

/**
 * What still blocks a submit, at the top of the questions, with a link to each open question. It
 * takes the focus after every attempt, so the rater learns what is missing without a dialog.
 */
export function ErrorSummary({
  items,
  issues,
  attempts,
  showCodes = true,
}: {
  items: Item[];
  issues: AnswerIssue[];
  attempts: number;
  showCodes?: boolean;
}) {
  const summary = useRef<HTMLDivElement>(null);
  // Only a new attempt moves the focus here; remounting (a resized window) does not.
  const seen = useRef(attempts);
  useLayoutEffect(() => {
    const element = summary.current;
    if (attempts > seen.current && element !== null) {
      reveal(element, "nearest");
    }
    seen.current = attempts;
  }, [attempts]);
  if (attempts === 0 || issues.length === 0) return null;
  const go = (id: string) => {
    const card = document.getElementById(itemAnchor(id));
    if (card !== null) reveal(card, "start");
  };
  return (
    <div ref={summary} tabIndex={-1} className="outline-none">
      <Alert variant="destructive">
        <AlertTitle>
          {issues.length === 1
            ? "One question needs an answer"
            : `${issues.length} questions need an answer`}
        </AlertTitle>
        <AlertDescription>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {issues.map((issue) => {
              const item = items.find((candidate) => candidate.id === issue.item);
              return (
                <li key={issue.item} className="flex min-w-0 gap-3">
                  <a
                    href={`#${itemAnchor(issue.item)}`}
                    className={
                      showCodes
                        ? "w-10 shrink-0 font-mono underline underline-offset-4"
                        : "min-w-0 break-words underline underline-offset-4"
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      go(issue.item);
                    }}
                  >
                    {showCodes || item === undefined ? issue.item : <Inline>{item.prompt}</Inline>}
                  </a>
                  {showCodes && item !== undefined && (
                    <span className="min-w-0 break-words">
                      <Inline>{item.prompt}</Inline>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}
