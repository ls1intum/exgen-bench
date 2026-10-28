import type { ReactNode } from "react";

/** A table that may scroll sideways, with a fade at its right edge while it is narrower than lg. */
export function Scrolling({ children }: { children: ReactNode }) {
  return (
    <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-10 after:bg-linear-to-l after:from-background after:to-transparent lg:after:hidden">
      {children}
    </div>
  );
}
