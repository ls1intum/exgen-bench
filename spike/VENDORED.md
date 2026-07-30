# Vendored Artemis sources

These files are copied **verbatim** from Artemis to prove the Tier-1 parsers can be reused
without depending on the Artemis Spring monolith. Do not edit; re-vendor from the pinned commit.

- **Source repo:** `ls1intum/Artemis`
- **Pinned commit:** `2019aa2db3901722c8ff1d0030d391260a4b31ed` (PR #13156, Hyperion)

| Vendored file (under `src/main/java/`) | Upstream path (same) |
|---|---|
| `de/tum/cit/aet/artemis/buildagent/service/parser/TestResultXmlParser.java` | identical |
| `de/tum/cit/aet/artemis/buildagent/dto/LocalCITestJobDTO.java` | identical |
| `de/tum/cit/aet/artemis/programming/dto/TestCaseBase.java` | identical |

**Transitive closure = these 3 files.** External deps: `jackson-dataformat-xml`, `commons-lang3` (+ JDK). No Spring, no JPA, no Artemis build-agent runtime.

Sample reports under `src/test/resources/samples/` are also from the pinned commit
(`src/test/resources/test-data/test-results/java-gradle/{all-succeed,all-fail}/...`).
