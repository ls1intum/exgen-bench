import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";

/**
 * Java highlighting with Shiki's CSS-variable theme, whose colours map onto design tokens through
 * class names: no inline colours, and nothing loaded until the first code view needs it.
 */

const TOKEN_CLASS: Record<string, string> = {
  "var(--shiki-token-keyword)": "text-code-keyword",
  "var(--shiki-token-string)": "text-code-string",
  "var(--shiki-token-string-expression)": "text-code-string",
  "var(--shiki-token-comment)": "text-code-comment",
  "var(--shiki-token-constant)": "text-code-constant",
  "var(--shiki-token-function)": "text-code-function",
};

let highlighter: Promise<HighlighterCore> | undefined;

// Shiki loads with the first code view, so the pages before the exercises do not wait for it.
function load(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [createCssVariablesTheme({ name: "tokens", variablePrefix: "--shiki-" })],
        langs: [import("shiki/langs/java.mjs"), import("shiki/langs/xml.mjs")],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  return highlighter;
}

export interface Token {
  text: string;
  className: string | undefined;
}

/** The language of a file by its name, or of a fenced code block by its info string. */
export function languageOf(pathOrLanguage: string): "java" | "xml" | null {
  if (pathOrLanguage === "java" || pathOrLanguage.endsWith(".java")) return "java";
  if (pathOrLanguage === "xml" || pathOrLanguage.endsWith(".xml")) return "xml";
  return null;
}

/** The lines of a file as tokens: plain until the highlighter has loaded, then highlighted. */
export function useHighlightedLines(path: string, code: string): Token[][] {
  const [highlighted, setHighlighted] = useState<{ code: string; lines: Token[][] } | null>(null);
  useEffect(() => {
    const lang = languageOf(path);
    if (lang === null) {
      return;
    }
    let current = true;
    void load().then((instance) => {
      if (!current) return;
      const { tokens } = instance.codeToTokens(code, { lang, theme: "tokens" });
      setHighlighted({
        code,
        lines: tokens.map((line) =>
          line.map((token) => ({
            text: token.content,
            className: token.color === undefined ? undefined : TOKEN_CLASS[token.color],
          })),
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [path, code]);
  return highlighted?.code === code
    ? highlighted.lines
    : code.split("\n").map((line) => [{ text: line, className: undefined }]);
}
