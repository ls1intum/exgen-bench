# Promise-to-test traceability suite

A study suite that measures whether a generated exercise's problem statement makes promises its
generated test suite never checks. It targets `artemis-java-maven` candidates: a Markdown problem
statement plus a JUnit 5 test tree.

## What this suite is for

The harness's mechanical bar is differential: the reference solution passes the tests and the
template fails them. A four-method suite clears that bar exactly as a fifteen-method suite does, and
neither the harness nor the generator's own critic can see a stated behaviour that no assertion
covers. This suite reports that gap and names the specific promises it believes are unexercised.

## What this suite is not

**`strict_success` here means "the candidate was measurable", not "the candidate is good."** The
suite emits no pass/fail quality threshold and no weighted composite, because no threshold has been
calibrated against human judgement. Do not wire this suite into a `strict-acceptance` denominator or
report it as an acceptance rate. Read the per-claim evidence.

A candidate is a quality failure only when it cannot be measured: no `response.json`, no
`problem_statement` or `tests` artifact, an empty statement, or a test tree with no Java sources.

## Declared metrics

Deterministic layer — no model, reproducible from the candidate bytes alone:

| metric | meaning |
| --- | --- |
| `promise.witnessed_ratio` | classified normative claims with an assertion-level witness, over all classified claims |
| `promise.unwitnessed_claims` | count of classified claims with no witness; the evidence lines name them |
| `promise.unclassified_normative_units` | statement sentences carrying a normative modal that no claim detector recognised — the visible blind spot of the layer |
| `api.member_reference_ratio` | statement-declared public API members referenced anywhere in the behavioural tests |
| `exception.assertthrows_ratio` | statement-named exception types with a matching `assertThrows` |
| `boundary.literal_ratio` | literal values stated in the prose that occur as literals in the behavioural tests |
| `tests.behavioural_methods` | behavioural test methods, excluding the Artemis structural lane |
| `tests.assertions` | assertion calls inside behavioural test methods |
| `tests.assertion_density` | assertions per behavioural test method |
| `tests.assertionless_methods` | behavioural test methods containing no assertion at all |
| `tests.structural_lane_present` | whether a structural oracle lane is separated from the behavioural lane |

Exploratory model-assisted layer — off unless `--model` and `--base-url` are supplied:

| metric | meaning |
| --- | --- |
| `promise.model_claims` | normative claims a model extracted from the prose |
| `promise.model_unwitnessed_claims` | of those, the ones the model judged unexercised |
| `promise.model_witnessed_ratio` | witnessed over extracted |

Every model-assisted metric is `tier: exploratory` and unvalidated. A model failure is reported as
an `infra_failure` on those scores only; it never changes the deterministic scores or the response
status.

## Claim catalogue

The deterministic layer recognises a closed catalogue of claim archetypes, each with a decidable
assertion-level witness. Claims outside the catalogue are counted in
`promise.unclassified_normative_units` rather than silently dropped, so the denominator is honest.

| archetype | statement trigger | witness |
| --- | --- | --- |
| `non_null_result` | never returns / never contains null, non-null | `assertNotNull`, or an `assertThrows` on a null input |
| `nullable_result` | returns null under a condition | `assertNull` |
| `no_mutation` | must not modify / leaves the original unchanged / copies the input | an assertion re-reads a call argument after the call, or the test mutates that argument and still asserts, or `assertThrows(UnsupportedOperationException)` |
| `exception` | any `*Exception` / `*Error` type named in prose | `assertThrows(<that type>.class, …)` |
| `ordering` | order, ordered, sorted, alphabetical | a whole-sequence assertion |
| `immutability` | immutable, unmodifiable, read-only | `assertThrows(UnsupportedOperationException.class, …)` |
| `empty_input` | empty input, list, string, map, script | an asserting test that constructs an empty value |

`boundary.literal_ratio` tracks a separate claim family — quoted strings and numbers written in
inline code or bold emphasis inside statement prose — and is deliberately excluded from
`promise.witnessed_ratio` so that literal counting cannot swamp the behavioural claims.

## Suite identity

`suite.digest` is the SHA-256 of the canonical map from file name to content digest over
`SUITE.md` and `metric-cards.json`. `evaluator.implementation_digest` covers the evaluator's seven
TypeScript source files. `evaluators/promise-traceability/identity.ts` computes both and
`tests/promise-traceability.test.ts` fails if either config drifts.
