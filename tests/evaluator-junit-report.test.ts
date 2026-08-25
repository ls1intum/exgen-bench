import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJUnitReports } from "../evaluators/java-oracle/junit-report.ts";

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ExampleTest" tests="5" failures="1" errors="1" skipped="1">
  <testcase name="passes" classname="ExampleTest"/>
  <testcase name="alsoPasses" classname="ExampleTest"></testcase>
  <testcase name="fails" classname="ExampleTest">
    <failure message="expected 6 but was &lt;0&gt;">stack</failure>
  </testcase>
  <testcase name="errors" classname="ExampleTest">
    <error message="boom &amp; more">stack</error>
  </testcase>
  <testcase name="skipped" classname="ExampleTest"><skipped/></testcase>
</testsuite>`;

describe("JUnit report parsing", () => {
  test("decodes failures and excludes skipped cases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-junit-report-"));
    try {
      await Bun.write(join(directory, "TEST-ExampleTest.xml"), REPORT);
      expect(await readJUnitReports(directory)).toEqual([
        { name: "passes", passed: true },
        { name: "alsoPasses", passed: true },
        { name: "fails", passed: false, message: "expected 6 but was <0>" },
        { name: "errors", passed: false, message: "boom & more" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns null when no report directory exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-junit-missing-"));
    try {
      expect(await readJUnitReports(join(directory, "missing"))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a truncated report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-junit-truncated-"));
    try {
      await Bun.write(
        join(directory, "TEST-Truncated.xml"),
        '<testsuite><testcase name="broken"><failure>unfinished</failure></testcase>',
      );
      await expect(readJUnitReports(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
