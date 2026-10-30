import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { DOMParser } from "@xmldom/xmldom";

import type { BundleFile } from "../../kit/bundle.ts";
import { tokenizeJava } from "../../kit/java/lexer.ts";
import { runHostBuild } from "./host-build.ts";

export interface CoverageLine {
  path: string;
  line: number;
  covered: boolean;
  branchesCovered: number;
  branchesMissed: number;
}
export interface SourceAnalysis {
  lines: CoverageLine[] | null;
  compiler: Array<{ path: string; line: number; kind: "raw_type" | "unchecked" }> | null;
  suppressions: number;
}

/** Read source counters, not bytecode instruction percentages. Missing reports are not zero coverage. */
export async function readSourceCoverage(path: string): Promise<CoverageLine[] | null> {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const document = new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
  if (document.documentElement?.tagName !== "report") return null;
  const result: CoverageLine[] = [];
  for (const pkg of Array.from(document.getElementsByTagName("package"))) {
    for (const file of Array.from(pkg.getElementsByTagName("sourcefile"))) {
      for (const line of Array.from(file.getElementsByTagName("line"))) {
        if (["nr", "mi", "ci", "mb", "cb"].some((k) => !line.hasAttribute(k))) return null;
        const values = ["nr", "mi", "ci", "mb", "cb"].map((k) => Number(line.getAttribute(k)));
        if (values.some((v) => !Number.isSafeInteger(v) || v < 0)) return null;
        const [nr, mi, ci, mb, cb] = values as [number, number, number, number, number];
        if (nr < 1 || mi + ci === 0) continue;
        result.push({
          path: `${pkg.getAttribute("name")}/${file.getAttribute("name")}`.replace(/^\//, ""),
          line: nr,
          covered: ci > 0,
          branchesCovered: cb,
          branchesMissed: mb,
        });
      }
    }
  }
  return result;
}

/** Disable only real standard suppression annotations, preserving source locations and literals. */
export function withoutWarningSuppressions(source: string): { source: string; count: number } {
  // A candidate-defined annotation with this name is not java.lang.SuppressWarnings.
  const shadowed =
    /\b(?:class|interface|enum)\s+SuppressWarnings\b|\bimport\s+(?!java\.lang\.)[\w.]+\.SuppressWarnings\s*;/.test(
      source,
    );
  const { tokens } = tokenizeJava(source);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.value !== "@") continue;
    let n = i + 1;
    let qualified = false;
    if (
      tokens[n]?.value === "java" &&
      tokens[n + 1]?.value === "." &&
      tokens[n + 2]?.value === "lang" &&
      tokens[n + 3]?.value === "."
    ) {
      qualified = true;
      n += 4;
    }
    if (shadowed && !qualified) continue;
    if (tokens[n]?.value !== "SuppressWarnings" || tokens[n + 1]?.value !== "(") continue;
    let depth = 1;
    let end = n + 2;
    for (; end < tokens.length; end++) {
      if (tokens[end]?.value === "(") depth++;
      if (tokens[end]?.value === ")" && --depth === 0) break;
    }
    if (depth === 0) ranges.push([token.start, tokens[end]!.end]);
    i = end;
  }
  for (const [start, end] of ranges.reverse())
    source =
      source.slice(0, start) +
      source.slice(start, end).replace(/[^\r\n]/g, " ") +
      source.slice(end);
  return { source, count: ranges.length };
}

/** Independent compile-only audit. The tested candidate is never rewritten. Suppressions are disclosed. */
export async function auditCompiler(
  directory: string,
  files: BundleFile[],
  javaHome: string | undefined,
  signal: AbortSignal,
): Promise<Pick<SourceAnalysis, "compiler" | "suppressions">> {
  let classpath: string;
  try {
    classpath = await readFile(join(directory, "build/exgen-classpath.txt"), "utf8");
  } catch {
    return { compiler: null, suppressions: 0 };
  }
  const root = join(directory, "exgen-compiler-audit");
  const diagnostics: NonNullable<SourceAnalysis["compiler"]> = [];
  let suppressions = 0;
  for (const file of files.filter((f) => f.path.endsWith(".java"))) {
    const clean = withoutWarningSuppressions(file.content);
    suppressions += clean.count;
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, clean.source);
    const run = await runHostBuild({
      argv: [
        javaHome ? join(javaHome, "bin/javac") : "javac",
        "-proc:none",
        "-XDrawDiagnostics",
        "-Xlint:unchecked,rawtypes",
        "-classpath",
        [join(directory, "build/classes/java/main"), classpath.trim()].join(delimiter),
        "-d",
        join(root, "classes"),
        path,
      ],
      directory,
      signal,
      timeoutMs: 60_000,
      maximumOutputBytes: 1024 * 1024,
    });
    if (run.timedOut || run.exitCode !== 0) return { compiler: null, suppressions };
    for (const line of run.output.split("\n")) {
      const match = /:(\d+):\d+: compiler\.warn\.([^:]+):/.exec(line);
      if (!match) continue;
      const key = match[2]!;
      const kind = key.includes("raw.class")
        ? "raw_type"
        : key.includes("unchecked") || line.includes("unchecked.")
          ? "unchecked"
          : null;
      if (kind) diagnostics.push({ path: file.path, line: Number(match[1]), kind });
    }
  }
  return {
    compiler: [...new Map(diagnostics.map((d) => [`${d.path}:${d.line}:${d.kind}`, d])).values()],
    suppressions,
  };
}

/** The init script adds measurement tasks without editing generated build scripts or source files. */
export const GRADLE_ANALYSIS_INIT = `allprojects { p ->
 p.plugins.withId('java') {
  p.pluginManager.apply('jacoco')
  p.jacoco.toolVersion = '0.8.14'
  p.tasks.withType(Test).configureEach { finalizedBy(p.tasks.named('jacocoTestReport')) }
  p.tasks.named('jacocoTestReport') { reports { xml.required = true; html.required = false } }
  p.tasks.register('exgenAnalysisClasspath') { doLast {
   def output = p.layout.buildDirectory.file('exgen-classpath.txt').get().asFile
   output.parentFile.mkdirs()
   output.text = p.sourceSets.main.compileClasspath.asPath
  } }
 }
}
`;
