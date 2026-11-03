import { describe, expect, test } from "bun:test";

import {
  changedClassNames,
  changedSources,
  isStudentWork,
  javaClassName,
} from "../tools/kit/changes.ts";

const file = (path: string, content: string) => ({ path, content });

describe("template-to-solution changes", () => {
  test("lists added, modified and removed sources, never build files or metadata", () => {
    const template = [
      file("build.gradle", "a"),
      file(".vscode/launch.json", "a"),
      file("src/p/Given.java", "class Given {}"),
      file("src/p/Stub.java", "class Stub { int f() { return 0; } }"),
      file("src/p/Old.java", "class Old {}"),
    ];
    const solution = [
      file("build.gradle", "b"),
      file(".vscode/launch.json", "b"),
      file("src/p/Given.java", "class Given {}"),
      file("src/p/Stub.java", "class Stub { int f() { return 1; } }"),
      file("src/p/New.java", "class New {}"),
    ];
    expect(
      changedSources(template, solution).map(({ path, change }) => `${change}:${path}`),
    ).toEqual(["added:src/p/New.java", "removed:src/p/Old.java", "modified:src/p/Stub.java"]);
    expect(isStudentWork("pom.xml")).toBe(false);
    expect(isStudentWork("settings.gradle.kts")).toBe(false);
    expect(isStudentWork("src/p/Stub.java")).toBe(true);
  });

  test("maps changed Java sources to class names, excluding tests, removals and descriptors", () => {
    const template = [
      file("src/de/x/Stub.java", "package de.x;\nclass Stub {}"),
      file("src/de/x/Gone.java", "package de.x;\nclass Gone {}"),
    ];
    const solution = [
      file("src/de/x/Stub.java", "package de.x;\nclass Stub { void f() {} }"),
      file("src/de/x/Added.java", "package de.x;\n\nclass Added {}"),
      file("src/de/x/package-info.java", "package de.x;"),
      file("src/test/java/de/x/StubTest.java", "package de.x;\nclass StubTest {}"),
      file("test/de/x/OtherTest.java", "package de.x;\nclass OtherTest {}"),
      file("src/Root.java", "class Root {}"),
      file("README.md", "changed"),
    ];
    expect(changedClassNames(template, solution)).toEqual(["Root", "de.x.Added", "de.x.Stub"]);
  });

  test("reads the package even when the lexer cannot", () => {
    expect(
      javaClassName("src/a/B.java", 'package a.b;\nclass B { String s = "unterminated; }'),
    ).toBe("a.b.B");
  });
});
