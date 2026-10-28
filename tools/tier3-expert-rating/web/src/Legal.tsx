import { cn } from "cn";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

import type { LegalDocument, LegalLink } from "../../shared/api.ts";
import { api } from "./api.ts";
import { Markdown } from "./material/Markdown.tsx";

/**
 * The deployment's legal documents, which every page links to in its footer. The operator sets
 * them; a deployment without them, such as the demo, shows no footer at all.
 */
const Links = createContext<LegalLink[]>([]);

export function SiteProvider({ children }: { children: ReactNode }) {
  const [links, setLinks] = useState<LegalLink[]>([]);
  useEffect(() => {
    // Without the links the survey still works; the footer then stays empty.
    api.site().then(
      (site) => setLinks(site.legal),
      () => undefined,
    );
  }, []);
  return <Links.Provider value={links}>{children}</Links.Provider>;
}

/** The link to one document, for a page that points to it in its text, such as the consent page. */
export function useLegalLink(id: LegalLink["id"]): LegalLink | undefined {
  return useContext(Links).find((link) => link.id === id);
}

/** The footer of every page; `inner` aligns its links with a page whose content is centred. */
export function Footer({ inner }: { inner?: string }) {
  const links = useContext(Links);
  if (links.length === 0) {
    return null;
  }
  return (
    <footer className="border-t px-4 py-1 sm:px-6">
      <nav aria-label="Legal" className={cn("w-full", inner)}>
        <ul className="m-0 flex list-none flex-wrap gap-x-4 p-0 text-xs text-muted-foreground">
          {links.map((link) => (
            <li key={link.id}>
              <a
                className="inline-flex min-h-6 items-center rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                href={link.href}
              >
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}

/** A legal document the survey shows itself; readable without a personal link. */
export function LegalPage({ id }: { id: string }) {
  const [document, setDocument] = useState<LegalDocument | "missing" | null>(null);
  useEffect(() => {
    api.legal(id).then(setDocument, () => setDocument("missing"));
  }, [id]);
  useEffect(() => {
    if (document !== null && document !== "missing") {
      window.document.title = document.title;
    }
  }, [document]);
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12"
      >
        {/* A rater who opened the notice from the consent page returns to where they were. */}
        <a
          className="self-start rounded-sm text-sm text-primary underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          href="/"
        >
          Back to the survey
        </a>
        {document === null && (
          <div aria-busy="true" className="flex justify-center">
            <Spinner />
          </div>
        )}
        {document === "missing" && (
          <Alert>
            <AlertTitle>No such page</AlertTitle>
            <AlertDescription>This survey has no document at this address.</AlertDescription>
          </Alert>
        )}
        {document !== null && document !== "missing" && (
          <article>
            {/* The operator's text names the page in its first heading; without one, the title does. */}
            {!/^#[ \t]/.test(document.markdown.trimStart()) && (
              <h1 className="mt-0 mb-4 text-2xl font-semibold tracking-tight">{document.title}</h1>
            )}
            <Markdown page>{document.markdown}</Markdown>
          </article>
        )}
      </main>
      <Footer inner="mx-auto max-w-2xl" />
    </div>
  );
}
