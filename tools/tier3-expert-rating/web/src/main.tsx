// First: it configures Zod before the shared schemas are defined.
import "./jitless.ts";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { LegalPage, SiteProvider } from "./Legal.tsx";
import "./styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing application root");
// The legal documents are pages of their own, which a reader opens without a personal link.
const legal = /^\/legal\/([a-z]+)$/.exec(window.location.pathname)?.[1];
// The study team's preview of the frozen exercises, behind its link or from exgen survey preview.
const preview = /^\/preview(?:\/|$)/.test(window.location.pathname);
const Preview = lazy(() =>
  import("./screens/Preview.tsx").then(({ Preview }) => ({ default: Preview })),
);

createRoot(root).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <SiteProvider>
        {legal !== undefined ? (
          <LegalPage id={legal} />
        ) : preview ? (
          <Suspense>
            <Preview />
          </Suspense>
        ) : (
          <App />
        )}
      </SiteProvider>
    </CSPProvider>
  </StrictMode>,
);
