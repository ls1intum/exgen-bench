import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { readTextBounded } from "../../src/core/files.ts";
import type { TestCaseResult } from "./backend.ts";

const MAXIMUM_REPORT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_REPORT_FILES = 10_000;

export function parseJUnitReport(xml: string): TestCaseResult[] {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("JUnit reports must not contain a document type");
  const document = new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
  return [...document.getElementsByTagName("testcase")].flatMap((testCase) => {
    const name = testCase.getAttribute("name");
    if (name === null || name.length === 0 || testCase.getElementsByTagName("skipped").length > 0) {
      return [];
    }
    const failure =
      testCase.getElementsByTagName("failure")[0] ?? testCase.getElementsByTagName("error")[0];
    const message = failure?.getAttribute("message") ?? undefined;
    return [
      {
        name,
        passed: failure === undefined,
        ...(message === undefined || message.length === 0 ? {} : { message }),
      },
    ];
  });
}

export async function readJUnitReports(directory: string): Promise<TestCaseResult[] | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const reports = entries.filter((entry) => entry.endsWith(".xml")).sort();
  if (reports.length === 0) return null;
  if (reports.length > MAXIMUM_REPORT_FILES) {
    throw new Error(`JUnit report directory exceeds ${MAXIMUM_REPORT_FILES} XML files`);
  }
  const cases: TestCaseResult[] = [];
  for (const report of reports) {
    cases.push(
      ...parseJUnitReport(await readTextBounded(join(directory, report), MAXIMUM_REPORT_BYTES)),
    );
  }
  return cases;
}
