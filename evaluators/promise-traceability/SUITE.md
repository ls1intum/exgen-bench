# Promise-to-test traceability suite

A study suite that measures whether a generated exercise's problem statement makes promises its
generated test suite never checks. It targets `artemis-java-maven` candidates: a Markdown problem
statement plus a JUnit 5 test tree. For what the suite is for, and what it must not be used for, see
[`README.md`](README.md).

## Lanes

The *structural lane* is the Artemis convention of classes extending a
`Class`/`Method`/`Attribute`/`Constructor` `TestProvider`, which reflectively check that the declared
API exists; the *behavioural lane* is every other file. Only the behavioural lane can
[witness](../../docs/GLOSSARY.md#witness) a promise, so every metric below is computed over it.

## Source reading

Java is read through a length-preserving lexer that blanks comment, string, character and text-block
bodies at their original offsets, so nothing inside a literal is read as structure. Four
consequences are load-bearing:

- a number occurring only inside a string does not count for `boundary.literal_ratio`;
- a member named only inside a text block does not count for `api.member_reference_ratio`, while a
  member named by a whole identifier-shaped string literal — a reflective lookup — does;
- numeric literals with underscore separators, width suffixes or hexadecimal form (`1_000`, `100L`,
  `3.5f`, `0x1F`) count at their decoded value;
- a stated literal is present only on exact equality with a test literal, never on containment.

## Measurability

`strict_success` records that the candidate was measurable, not that it is good. The suite emits no
quality threshold and no weighted composite. A candidate is a quality failure only when it cannot be
measured: no `response.json`, no `problem_statement` or `tests` artifact, an artifact path that
escapes the bundle or crosses a symlink, an empty statement, or a test tree with no Java sources or
past the evaluator's declared file, byte and depth bounds.

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
| `promise.model_unwitnessed_claims` | of those, the ones the model judged unwitnessed |
| `promise.model_witnessed_ratio` | witnessed over extracted |

Every model-assisted metric is `tier: exploratory` and unvalidated. A model failure is reported as
an `infra_failure` on those scores only; it never changes the deterministic scores or the response
status.

## Claim catalogue

A closed catalogue of [claim archetypes](../../docs/GLOSSARY.md#claim-archetype), each with a
decidable assertion-level witness. A sentence carrying a normative modal that matches no archetype is
counted in `promise.unclassified_normative_units` rather than dropped, so the denominator can be
audited. Sentences that frame the exercise — *"the template already contains…"*, *"in this exercise
we work with…"* — are excluded: they describe scaffolding, not behaviour the student must deliver.

Triggers are the complete alternations of `CLAIM_PATTERNS` in `statement.ts`, matched
case-insensitively against one sentence with Markdown emphasis stripped; `…` is a gap of at most
60–70 characters that no sentence end crosses.

| archetype | statement trigger | witness |
| --- | --- | --- |
| `non_null_result` | `never`/`not`/`no` … `return(s\|ing\|ed)`/`result`/`contain(s\|ing)`/`hold(s)`/`produce(s)`/`yield(s)` … `null`; or `return(s\|ed)`/`result` … `never (be) null` | `assertNotNull` on a result of a member under test, or an `assertThrows` in a method that calls a member under test with `null` |
| `nullable_result` | `return(s) null`; `null is returned` | `assertNull` on a result of a member under test |
| `no_mutation` | `never`/`not`/`without`/`neither`/`nor` … `modif`/`mutat`/`alter`/`chang`; `leav*`/`remain*`/`stay*` … `unchanged`/`untouched`/`unaffected`/`intact`; `original`/`input`/`supplied`/`given`/`caller('s)` … `unchanged`/`untouched`/`unaffected`/`not modified`; `defensive cop`; `cop(y\|ies) (of) the supplied`/`given`/`input`/`original`; `without influencing` | an assertion re-reads a call argument after the call under test, or the test mutates that argument after the call and still asserts |
| `exception` | any `*Exception` or `*Error` type named in prose | `assertThrows`/`assertThrowsExactly`/`assertInstanceOf` on that type's class literal, or `instanceof` that type |
| `ordering` | `in (the) order`; `ordered`; `ordering`; `sorted`; `alphabetical` | an assertion compares a whole sequence, or asserts at two distinct integer element positions |
| `immutability` | `immutab`; `unmodifiable`; `read(-)only`; `cannot be modified` | `assertThrows(UnsupportedOperationException.class, …)`, or the `no_mutation` witness |
| `empty_input` | `empty` (not preceded by `non-` or `not `) … `input`/`list`/`string`/`collection`/`array`/`map`/`set`/`script`/`text`/`source`; one of those nouns … `is empty`; `empty input` | an asserting test that constructs an empty value |

A sentence that fires `non_null_result` does not also record `nullable_result`. Each archetype is
recorded at most once per candidate; `exception` once per named type.

`boundary.literal_ratio` tracks a separate family — quoted strings and numbers written in inline
code or bold emphasis inside statement prose — and reports only that each stated literal is
**present** in the tests, not that anything asserts on it. It is excluded from
`promise.witnessed_ratio` for that reason, and so that literal counting cannot swamp the behavioural
claims.

## Suite identity

`suite.digest` is the SHA-256 of the canonical map from file name to content digest over `SUITE.md`
and `metric-cards.json`. `evaluator.implementation_digest` covers every module `worker.ts` reaches
through relative imports — the evaluator's own sources and the `src/` modules they load — walked
from the import graph rather than a hand-kept list, so no module can change what is measured without
changing the evaluator's identity. `identity.ts` prints that file list and both digests;
`tests/promise-traceability.test.ts` fails if either config drifts.
