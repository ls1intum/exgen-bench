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

export function Footer() {
  const links = useContext(Links);
  if (links.length === 0) {
    return null;
  }
  return (
    <footer className="border-t px-4 py-2 sm:px-6">
      <nav aria-label="Legal">
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
          {links.map((link) => (
            <li key={link.id}>
              <a
                className="underline-offset-4 hover:text-foreground hover:underline"
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

/** The document's own title (its leading `# ` line) as the page's heading, and the rest as its text. */
function titled(document: LegalDocument): { title: string; body: string } {
  const match = /^#[ \t]+(.+)\r?\n/.exec(document.markdown.trimStart());
  return match === null
    ? { title: document.title, body: document.markdown }
    : {
        title: match[1]?.trim() ?? document.title,
        body: document.markdown.trimStart().slice(match[0].length),
      };
}

/** A legal document the survey shows itself; readable without a personal link. */
export function LegalPage({ id }: { id: string }) {
  const [document, setDocument] = useState<LegalDocument | "missing" | null>(null);
  useEffect(() => {
    api.legal(id).then(setDocument, () => setDocument("missing"));
  }, [id]);
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main
        id="main-content"
        className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12"
      >
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
          <article className="flex flex-col gap-4">
            <h1 className="m-0 text-xl font-semibold">{titled(document).title}</h1>
            <Markdown>{titled(document).body}</Markdown>
          </article>
        )}
      </main>
      <Footer />
    </div>
  );
}
