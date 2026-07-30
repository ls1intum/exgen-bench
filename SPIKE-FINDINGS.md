# Phase 1 — Footprint Spike & BubbleSort Parity: Findings

**Date:** 2026-07-22 · **Scope:** resolve the Artemis dependency-footprint decision (§13.1) and validate the standalone-runner approach against Artemis's own build/parse code, using the SortingExample (BubbleSort) reference exercise. See `SYSTEM-DESIGN.md`.

**Pinned Artemis commit:** `2019aa2db3901722c8ff1d0030d391260a4b31ed` (PR #13156).

## TL;DR — GO

The standalone-runner design is validated. The dependency-footprint question is **resolved: vendor the parsers, replicate the sandbox + oracle logic.** Two of the three risky unknowns are retired with working proof (parser reuse, build substrate). The remaining item — byte-faithful exercise *assembly* — is a well-scoped implementation task (`:adapter-artemis`), not a research risk: the canonical reference and Artemis's own Docker integration test give a known-good cross-check.

| Phase-1 goal | Status |
|---|---|
| Footprint decision (§13.1) | ✅ **Resolved** — vendor parsers (proven: compiles + runs standalone) |
| Parsing parity | ✅ **Proven** — vendored parser reads real Artemis reports |
| Build substrate (JDK17 + Maven + Ares on arm64) | ✅ **Validated** in Docker |
| BubbleSort oracle parity (solution passes / template structural-credit) | ◻ **Set up** — inputs gathered; needs the faithful assembler (next step) |

## Environment (this machine)

| | |
|---|---|
| CPU / RAM | Apple M-series, **12 cores, 32 GB** (design assumed 48–64 GB for the final eval host — see note) |
| Docker | 29.5.2, daemon reachable; arm64 images pull & run natively |
| Host JDK | OpenJDK **25**/**26** (+ Corretto 8). **Too new for Ares' SecurityManager** (removed in JDK 24+) |
| Maven / Gradle / git | 3.9.11 / 9.6.1 / 2.50.1 |

**Consequence:** exercise builds **must** run in the pinned JDK-17 container, never on host Java. This is exactly what the standalone-runner design already prescribes (build in Docker), so it is confirmation, not a change. *(RAM note: this dev machine has 32 GB; if the final eval host is 48–64 GB the §11 concurrency budget holds, otherwise cap concurrent oracle builds to ~6.)*

## 1. Footprint spike → **vendor the parsers**

**Question:** can we reuse Artemis's build/parse code standalone, or does it drag in Spring/JPA/the monolith?

**Method:** static import analysis of the reuse candidates + a build proof.

**Result — the test parser is a plain, Spring-free utility.** `TestResultXmlParser` is a `public class` with `static` methods; its entire Artemis transitive closure is **3 files**:

```
TestResultXmlParser  →  LocalCITestJobDTO  →  TestCaseBase   (no further Artemis imports)
```

External deps: `jackson-dataformat-xml` + `commons-lang3` only. The SCA `ReportParser` is likewise a plain static class backed by a self-contained `scaparser/` package. In contrast, `DifferentialVerificationService` is a Spring `@Service` that `@Autowired`s a JPA repository, and `InteractiveSandbox` is build-agent/Docker runtime — so those are **replicated**, not reused.

**Proof (see `spike/`):** the 3 files were vendored verbatim and compiled + tested standalone.

```
Tests run: 2, Failures: 0, Errors: 0
runtime classpath = jackson-{annotations,core,databind,dataformat-xml} + woodstox/stax2 + commons-lang3
                    (zero Spring, zero Artemis jars)
```

**Decision (resolves §13.1):**

| Artemis component | Reuse strategy |
|---|---|
| `TestResultXmlParser` (+ `LocalCITestJobDTO`, `TestCaseBase`) | **Vendor** (verbatim, pin commit) |
| SCA `ReportParser` (+ `scaparser/` pkg, SCA DTOs) | **Vendor** (self-contained; needed for #6/#7/#12) |
| `verify.sh` recipe (`SandboxBuildCommandService`) | **Vendor/port** the script template |
| `DifferentialVerificationService` oracle logic | **Replicate** (Spring/JPA-coupled) — semantics already captured in the design |
| `InteractiveSandbox` sandbox execution | **Replicate** with a thin Docker layer (docker-java/Testcontainers) |

Re-vendoring from a pinned commit + the BubbleSort parity cross-check keeps drift in check. No dependency on the Artemis monolith or Spring.

## 2. Parsing parity → **proven**

The vendored parser was run on two real Artemis `SortingExampleBehaviorTest` reports:
- `all-succeed` → 4 passed, 0 failed ✓
- `all-fail` → 0 passed, 4 failed ✓, and it correctly surfaced the **structural-credit** message *"The class 'Context' was not found within the submission"* — the exact signal the oracle (#3) must interpret for template starter-credit.

## 3. Build substrate → **validated**

`docker run maven:3.9-eclipse-temurin-17` on this machine:
- pulls & runs natively on **aarch64**; JDK **17.0.19** (Temurin) — SecurityManager-capable;
- **Ares `de.tum.in.ase:artemis-java-test-sandbox:1.15.0` resolves from Maven Central** (`ARES_RESOLVED_OK`).

So the containerized JDK-17 + Maven + Ares toolchain works on the M5. (For production runs the design still bakes an offline dependency cache into a network-isolated image; here network-on resolution is how that cache would be seeded.)

## 4. BubbleSort oracle parity → set up; needs the faithful assembler

The full oracle parity (solution passes all; template **fails behavioural but passes seeded structural** tests) requires assembling a real MAVEN_MAVEN exercise. All inputs are gathered from the pinned commit:

- **Reference exercise:** the Java "SortingExample" template — `templates/java/{exercise,solution}/src/<pkg>/{BubbleSort,MergeSort,Context,Policy,SortStrategy}.java`, tests `templates/java/test/testFiles/{behavior/SortingExampleBehaviorTest,structural/*}.java` + `test.json`.
- **Maven build files:** `templates/java/maven_maven/{exercise,solution}/pom.xml`, `templates/java/test/maven/projectTemplate/pom.xml` (Ares 1.15.0, `<source/target>17`, surefire 3.5.3, checkstyle 10.17.0, spotbugs 4.8.4.0), `test/stagePom.xml`, `test/staticCodeAnalysisConfig/*`.
- **Minimal alt. fixture:** Hyperion's readiness `ScoreCalculator` (`templates/hyperion/readiness/java/{solution,tests}/...`), tests `testPublicApi/testRepresentativeScores/testBoundaryScores/testEmptyInput`.
- **Recipe + cross-check:** `SandboxBuildCommandService.verify.sh` and `HyperionBuildReadinessDockerIntegrationTest` (Artemis's own containerized build test, parameterised over PLAIN_MAVEN/MAVEN_MAVEN).

**Deliberately not guessed here:** the exact `BuildRecipe` for MAVEN_MAVEN — `assignmentDir`, `testDir`, the `${studentWorkingDirectory}` value, how the assignment overlays into the test project's `sourceDirectory`, and structural-test seeding (`test.json`). Guessing these would produce an assembly error masquerading as a "parity" result. They are the first task of the `:adapter-artemis` module.

**Next steps (start of the adapter implementation):**
1. Port the `BuildRecipe`/`verify.sh` assembly for MAVEN_MAVEN (read the recipe defs; don't guess).
2. Assemble SortingExample solution & template repos + tests repo; substitute placeholders (`${packageName}` → `de.tum.in.ase`, etc.).
3. Run both builds in `maven:3.9-eclipse-temurin-17` with `-Djava.security.manager=allow`; collect surefire XML.
4. Parse with the vendored parser; apply the oracle; **assert:** solution 100 %; template fails `testBubbleSort/testMergeSort` etc. but passes seeded structural tests.
5. Cross-check the verdict against `HyperionBuildReadinessDockerIntegrationTest` expectations.

## Spike artifacts

- `spike/` — Maven project: vendored parser (`src/main/java/...`), smoke test (`src/test/java/...`), sample reports, `pom.xml`, `VENDORED.md`.
- Run: `cd spike && JAVA_HOME=<any JDK 17+> mvn test` (host JDK 21/25 fine for the harness itself; only *exercise* builds need the JDK-17 container).
