import { CSPProvider } from "@base-ui/react/csp-provider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { LegalPage, SiteProvider } from "./Legal.tsx";
import "./styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing application root");
// The legal documents are pages of their own, which a reader opens without a personal link.
const legal = /^\/legal\/([a-z]+)$/.exec(window.location.pathname)?.[1];

createRoot(root).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <SiteProvider>{legal === undefined ? <App /> : <LegalPage id={legal} />}</SiteProvider>
    </CSPProvider>
  </StrictMode>,
);
