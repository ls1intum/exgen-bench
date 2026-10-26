import { CodeBlockLine } from "@/components/ui/code-block";

import { useHighlightedLines } from "./highlight.ts";

/** A file's lines for a CodeBlockContent, highlighted by our token classes once Shiki has loaded. */
export function CodeLines({ path, code }: { path: string; code: string }) {
  const lines = useHighlightedLines(path, code);
  return lines.map((tokens, index) => (
    // Lines of an immutable file: the index is the line's identity.
    // oxlint-disable-next-line react/no-array-index-key
    <CodeBlockLine key={index}>
      {tokens.map((token, position) =>
        token.className === undefined ? (
          token.text
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          <span key={position} className={token.className}>
            {token.text}
          </span>
        ),
      )}
    </CodeBlockLine>
  ));
}
