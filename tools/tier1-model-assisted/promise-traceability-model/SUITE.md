# Promise traceability, model-assisted suite

The model-assisted counterpart of the deterministic
[promise-traceability](../../tier1-deterministic/promise-traceability/SUITE.md) suite. A language
model extracts the normative claims of the problem statement and decides, for each, whether the
JUnit test suite witnesses it: whether an assertion would fail if the claim were violated.

One bounded chat completion per candidate, at temperature 0, with the statement truncated to 12,000
and the tests to 24,000 characters. The answer must be JSON of the agreed shape and at most 24
claims; anything else fails closed.

| metric | meaning |
| --- | --- |
| `promise.model_claims` | normative claims the model extracted from the prose |
| `promise.model_unwitnessed_claims` | of those, the ones the model judged unwitnessed |
| `promise.model_witnessed_ratio` | witnessed over extracted; not applicable when nothing was extracted |

Every metric is `tier: exploratory` and unvalidated. `strict_success` records that the model
answered and the candidate was measurable, not that it is good. A candidate with no readable
statement or tests is `quality_failed` with `candidate.incomplete`; a provider error, timeout or
malformed answer is `infra_failed` and may be retried.
