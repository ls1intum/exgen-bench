const setupPaths = new Set([
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradlew",
  "gradlew.bat",
  "gradle/libs.versions.toml",
  "pom.xml",
  "mvnw",
  "mvnw.cmd",
  ".gitattributes",
  ".gitignore",
  ".editorconfig",
]);
const setupDirectories = ["gradle/wrapper/", ".mvn/wrapper/", ".vscode/", ".idea/"];

function mentionsFile(instructions: string, path: string) {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match an explicit filename even in Markdown or at the end of a sentence, but not a longer
  // path or extension. The exact and short paths both occur in student instructions.
  return new RegExp(
    `(?:^|[^\\w./-])(?:${escape(path)}|${escape(leaf)})(?=$|[^\\w./-]|\\.(?=\\s|$))`,
    "i",
  ).test(instructions);
}

/** Group routine root-level setup without hiding exercise data or a file named in the task. */
export function groupStarterFiles<T extends { path: string; content?: string }>(
  files: readonly T[],
  statement: string,
): { main: T[]; setup: T[] } {
  // Some exercises put their student instructions in a root README rather than inline in Artemis.
  const instructions = [
    statement,
    ...files
      .filter((file) => /^(?:README|INSTRUCTIONS)(?:\.(?:md|txt))?$/i.test(file.path))
      .map((file) => file.content ?? ""),
  ].join("\n");
  const main: T[] = [];
  const setup: T[] = [];
  for (const file of files) {
    const routine =
      setupPaths.has(file.path) || setupDirectories.some((prefix) => file.path.startsWith(prefix));
    (routine && !mentionsFile(instructions, file.path) ? setup : main).push(file);
  }
  return { main, setup };
}
