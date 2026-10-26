// The engine is served as a file of its own, not bundled: it is 3 MB and only statements with a
// diagram load it.
// oxlint-disable-next-line import/default -- Vite gives a `?url` import a default export.
import engineUrl from "@plantuml/core/plantuml.js?url";

interface Engine {
  renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
  ): void;
}

let engine: Promise<Engine> | undefined;

/**
 * Render PlantUML to SVG in the browser with PlantUML's own engine (`@plantuml/core`, compiled from
 * the Java engine Artemis runs), so text is measured with the rater's own fonts and no diagram
 * leaves the page. The statement selects the Smetana layout, which needs no Graphviz.
 */
export function renderDiagram(source: string): Promise<string> {
  engine ??= import(/* @vite-ignore */ engineUrl) as Promise<Engine>;
  return engine.then(
    ({ renderToString }) =>
      new Promise<string>((resolve, reject) =>
        renderToString(source.split("\n"), resolve, (message) => reject(new Error(message))),
      ),
  );
}
