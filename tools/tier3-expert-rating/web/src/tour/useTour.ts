import { cn } from "cn";
import { type Alignment, type Driver, driver, type PopoverDOM, type Side } from "driver.js";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

import { buttonVariants } from "@/components/ui/button";

/** One stop of a guided tour: an element on screen and a short explanation beside it. */
export interface TourStop {
  /** The element the stop points at, or null where the current layout has none. */
  target: () => Element | null;
  /** Bring the target on screen first, such as turning a narrow screen to the questions. */
  prepare?: () => void;
  title: string;
  text: string;
  side?: Side;
  align?: Alignment;
}

interface TourOptions {
  /** Where the browser remembers that the tour was seen; losing it only shows the tour again. */
  storageKey: string;
  /** Start by itself, once, if the browser has not seen it yet. */
  auto: boolean;
  /** The stops, read when the tour starts, so that they match the screen at that moment. */
  stops: () => TourStop[];
  /** Note what the stops will change, when the tour starts (not when it restarts). */
  onStart?: () => void;
  /** Put back what the stops changed, once the tour ends. */
  onEnd?: () => void;
}

function seen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function remember(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Without storage the tour shows again next time, which does no harm.
  }
}

const ARIA = ["aria-haspopup", "aria-expanded", "aria-controls"];

const visible = (element: Element | null): element is Element =>
  element !== null && element.getClientRects().length > 0;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The target once its position held still for a frame, after at most a few frames. */
async function settled(target: () => Element | null): Promise<Element | null> {
  let last = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    await frame();
    const element = target();
    const box = element?.getBoundingClientRect();
    const now = box === undefined ? "" : `${box.top},${box.left},${box.width},${box.height}`;
    if (now === last) return element;
    last = now;
  }
  return target();
}

/** The popover's text is set as HTML by driver.js; the stops are plain text. */
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

function addClasses(element: HTMLElement, classes: string) {
  element.classList.add(...classes.split(" ").filter(Boolean));
}

/**
 * Restyle driver.js's popover with the app's buttons: the step count above the title, and a footer
 * with "Skip tour" apart from Back and Next, like the app's dialogs.
 */
function decorate(
  popover: PopoverDOM,
  { first, last }: { first: boolean; last: boolean },
  onSkip: () => void,
) {
  const { wrapper, title, progress, footer, footerButtons, previousButton, nextButton } = popover;
  wrapper.insertBefore(progress, title);
  for (const button of [previousButton, nextButton]) {
    button.classList.remove("driver-popover-footer-btn");
    // driver.js shows its buttons as blocks; the app's buttons lay out their label themselves.
    if (button.style.display === "block") button.style.display = "";
  }
  // The first stop has nothing to go back to: no disabled button, just none.
  if (first) previousButton.style.display = "none";
  addClasses(previousButton, buttonVariants({ variant: "outline", size: "sm" }));
  addClasses(nextButton, buttonVariants({ size: "sm" }));
  let skip = footer.querySelector<HTMLButtonElement>("[data-tour-skip]");
  if (skip === null) {
    skip = document.createElement("button");
    skip.type = "button";
    skip.dataset.tourSkip = "";
    skip.textContent = "Skip tour";
    skip.className = cn(buttonVariants({ variant: "ghost", size: "sm" }), "tour-skip");
    skip.addEventListener("click", onSkip);
    footer.insertBefore(skip, footerButtons);
  }
  skip.hidden = last;
}

/**
 * A guided tour over the screen with driver.js: one highlighted element at a time with a popover
 * beside it. It starts by itself once per browser and rater, can be skipped at every stop with the
 * button or Escape, and can be started again. The page behind it stays as it was.
 */
export function useTour({ storageKey, auto, stops, onStart, onEnd }: TourOptions) {
  const latest = useRef({ storageKey, stops, onStart, onEnd });
  useLayoutEffect(() => {
    latest.current = { storageKey, stops, onStart, onEnd };
  });
  const instance = useRef<{ driver: Driver; index: number; cleanup: () => void } | null>(null);
  /** Why the running tour ends: the rater ended it, it starts again, or the screen goes away. */
  const ending = useRef<"rater" | "restart" | "leave">("rater");

  const stop = useCallback((reason: "rater" | "restart" | "leave") => {
    const current = instance.current;
    if (current === null) return;
    ending.current = reason;
    if (current.driver.isActive()) current.driver.destroy();
    else current.cleanup();
  }, []);

  const start = useCallback(
    (from = 0) => {
      const restart = instance.current !== null;
      stop("restart");
      if (!restart) latest.current.onStart?.();
      const all = latest.current.stops().filter((candidate) => candidate.target() !== null);
      if (all.length === 0) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        stop("rater");
      };
      const cleanup = () => {
        document.removeEventListener("keydown", onKey, true);
        instance.current = null;
        const reason = ending.current;
        ending.current = "rater";
        if (reason === "rater") remember(latest.current.storageKey);
        if (reason !== "restart") latest.current.onEnd?.();
      };
      let aria: Record<string, string | null> = {};
      /** Counts the moves, so that a move overtaken by a quicker click gives way. */
      let moves = 0;
      /** Show the stop at `index`, or the next one in `direction` whose target is on screen. */
      const show = async (index: number, direction: 1 | -1) => {
        const move = ++moves;
        for (let next = index; next >= 0 && next < all.length; next += direction) {
          const candidate = all[next] as TourStop;
          flushSync(() => candidate.prepare?.());
          // A pane that was just hidden leaves the layout a frame or two later, so the target
          // moves once more before it settles.
          const target = await settled(candidate.target);
          const current = instance.current;
          if (move !== moves || current?.driver !== tour) return;
          if (!visible(target)) continue;
          // driver.js counts a target as in view once it is inside the window, even when it sits
          // under a sticky bar of an inner scroller; scrolling it into view honours the bar's
          // scroll padding. At once, so that the popover is placed where the target ends up.
          target.scrollIntoView({ block: "nearest", behavior: "instant" });
          aria = Object.fromEntries(ARIA.map((name) => [name, target.getAttribute(name)]));
          current.index = next;
          if (current.driver.isActive()) current.driver.moveTo(next);
          else current.driver.drive(next);
          return;
        }
        stop("rater");
      };
      const tour = driver({
        animate: !reduce,
        smoothScroll: false,
        allowClose: true,
        // Arrow keys would also turn the stops while a radio group has the focus; Escape is ours.
        allowKeyboardControl: false,
        // A stray click beside the popover should not end the tour; Skip and Escape do.
        overlayClickBehavior: () => {},
        overlayColor: "var(--foreground)",
        overlayOpacity: 0.45,
        stagePadding: 6,
        stageRadius: 10,
        popoverOffset: 12,
        disableActiveInteraction: true,
        showProgress: true,
        progressText: "{{current}} of {{total}}",
        showButtons: ["next", "previous"],
        nextBtnText: "Next",
        prevBtnText: "Back",
        doneBtnText: "Done",
        popoverClass: "tour-popover",
        steps: all.map((candidate) => ({
          element: () => candidate.target() as Element,
          popover: {
            title: escape(candidate.title),
            description: escape(candidate.text),
            ...(candidate.side === undefined ? {} : { side: candidate.side }),
            ...(candidate.align === undefined ? {} : { align: candidate.align }),
          },
        })),
        onPopoverRender: (popover, { state }) => {
          const index = state.activeIndex ?? 0;
          decorate(popover, { first: index === 0, last: index === all.length - 1 }, () =>
            stop("rater"),
          );
          // Next is where a keyboard user goes on; the dialog's name and text are read with it.
          requestAnimationFrame(() => popover.nextButton.focus());
        },
        onNextClick: () => {
          const index = instance.current?.index ?? 0;
          if (index >= all.length - 1) stop("rater");
          else void show(index + 1, 1);
        },
        onPrevClick: () => void show((instance.current?.index ?? 0) - 1, -1),
        // driver.js marks the target as opening a dialog, which most targets (a region, a card)
        // may not claim; the target keeps its own attributes instead.
        onHighlighted: (element) => {
          if (element === undefined) return;
          for (const [name, value] of Object.entries(aria)) {
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
          }
        },
        onDestroyed: cleanup,
      });
      instance.current = { driver: tour, index: 0, cleanup };
      document.addEventListener("keydown", onKey, true);
      void show(Math.min(from, all.length - 1), 1);
    },
    [stop],
  );

  // The first time only, once the screen has laid out.
  useEffect(() => {
    if (!auto || seen(storageKey)) return;
    const timer = window.setTimeout(() => start(), 300);
    return () => window.clearTimeout(timer);
  }, [auto, storageKey, start]);

  // Leaving the screen ends the tour without counting it as seen.
  useEffect(() => () => stop("leave"), [stop]);

  /** Show the current stop again, for a layout that changed under the tour. */
  const refresh = useCallback(() => {
    const current = instance.current;
    if (current !== null) start(current.index);
  }, [start]);

  return { start: () => start(), refresh };
}
