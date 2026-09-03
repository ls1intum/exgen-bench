# Artemis production-API adapter

*"Production API" means the adapter drives the same endpoints the instructor UI does, rather than a
benchmark-only API. It does not mean the feature under test is in production — see Upstream status.*

This adapter measures the Hyperion exercise-generation feature, which is **not yet merged into
Artemis**: it currently exists only on the branch `hyperion-agentic-production-design`. The adapter
signs in as an ordinary editor, creates one unreleased draft in a dedicated course in the format
`target.parameters` selects — Java/Maven by default, which is the only format the branch's verifier
supports — starts generation through that branch's endpoint, follows the job status, and captures the exact
persisted exercise version and the instructor exports of the template, solution, and test
repositories.

## Upstream status

Every claim below describes the branch under test, not `origin/develop`. Verified against Artemis at
the time of writing:

| Capability the adapter depends on | On `origin/develop`? |
| --- | --- |
| `POST/GET/DELETE .../generate-exercise[/status\|/jobs/{id}]` | **No** — the whole `exercisegeneration` package is branch-only |
| `GET .../generation/supported-languages` | **No** |
| `GET .../generation/effort-profiles`, and `effortProfile` / `maxTokens` / `maxJobDuration` on the start request | **No** — branch-only, and newer than the rest of it |
| Three-valued `accountingState` and the `effortProfile` echo on the status | **No** — branch-only; the adapter requires them and fails loudly without |
| `artemis.hyperion.job.id` trace correlation attribute | **No** — added by the branch |
| Hyperion sandbox-slot and token-budget admission control | **No** |
| `management.opentelemetry.*` configuration tree | **No** — develop has only the older `management.otlp.tracing` shape, so most of the environment block below binds to properties that do not exist there |
| Standard `gen_ai.input.messages` / `gen_ai.output.messages` capture | **No** — develop's only content filter is Langfuse-gated and emits the older concatenated `gen_ai.prompt` / `gen_ai.completion` |
| `GET /api/exercise/exercises/{id}/versions/{versionId}` | Yes |
| `GET .../export-instructor-repository/{TEMPLATE\|SOLUTION\|TESTS}` | Yes |
| `POST .../programming-exercises/setup?emptyRepositories=true` | Yes |

So the exercise-version snapshot and the instructor repository exports are already upstream; the
generation feature and its telemetry correlation are what an evaluation of this branch is measuring.
Treat every "Artemis does X" statement in this file as "the branch under test does X", and re-verify
against `origin/develop` before repeating any of it as a claim about released Artemis.

The adapter requires no benchmark-only endpoints, tables, or database migrations on either. That is
a property of the adapter's design and holds today. Provider-neutral usage and request identifiers
come from the branch's bounded reconnect status and expire with that status; exgen captures them
immediately into immutable attempt evidence.

OpenTelemetry is a separate, independently checked evidence plane. Artemis emits its normal
Micrometer/Spring AI spans over OTLP; a standard OpenTelemetry Collector writes OTLP JSON, and the
adapter consumes the exact trace correlated by `artemis.hyperion.job.id`. Note that essentially this
whole plane is branch work, not just the correlation attribute: the `management.opentelemetry.*`
property tree, the standard `gen_ai.input.messages` / `gen_ai.output.messages` content filter, and
the correlation attribute in `GenerationTaskService` are all added by the branch. The environment
block below will not configure a `origin/develop` deployment. What is unchanged either way is that no
benchmark telemetry receiver or persistence is added to Artemis.

## Campaign setup

Provision one isolated Artemis deployment for the campaign and one dedicated course per study arm.
Put each course ID in that arm's system parameters. The adapter never creates or deletes a course
per attempt. Use dedicated editor accounts; an administrator is only needed for provisioning.

```bash
cp adapters/artemis/parameters.example.json /tmp/artemis-parameters.json
export ARTEMIS_BENCHMARK_USERNAME=...
export ARTEMIS_BENCHMARK_PASSWORD=...
export ARTEMIS_OTEL_TRACES_PATH=/absolute/path/to/otel-evidence/artemis-traces.jsonl
bun adapters/artemis/campaign.ts environment --parameters /tmp/artemis-parameters.json \
  > /tmp/artemis-benchmark-environment.json
bun adapters/artemis/campaign.ts preflight --parameters /tmp/artemis-parameters.json \
  --target-parameters adapters/artemis/target-parameters.example.json
```

The preflight verifies that the account can list the configured course and that Hyperion advertises
the language the campaign will actually request. Without `--target-parameters` it checks the default
format. Credentials are referenced by environment-variable name and never written into attempt
evidence.

### Effort profiles are the one factor Artemis attests

Artemis accepts three narrowing controls on a start request: an `effortProfile` *name* drawn from an
admin-defined set, and `maxTokens` / `maxJobDuration`, which may only tighten that profile and never
widen it. It echoes exactly one of them back on the terminal status — the profile the run actually
resolved to — so a caller can verify what ran rather than what it asked for.

That asymmetry decides what may be a factor. `effort_profile` is a factor: the adapter sends it and
reports `execution.observed_factors.effort_profile` **from the status**, so a run that silently
resolved to a different profile shows up as a disagreement instead of as a result. The two numeric
bounds are not factors — Artemis applies them but attests neither, so an arm varying them would rest
on the adapter's word. They are reachable as `parameters.generation.max_tokens` and
`parameters.generation.max_job_duration_ms`, and a study that names one as a factor is refused with a
message pointing at the parameter.

The descriptor declares the two as separate lists — `controls: ["effort_profile"]` and
`observes: ["effort_profile"]` — because the asymmetry is the point: an adapter has to be able to say
"I apply this but cannot vouch for it", which is exactly the position `maxTokens` is in. Preflight
refuses a study naming a factor outside those lists, and the adapter refuses it again at request
time from the same constants, so the declaration and the enforcement cannot drift. Factor names are
bare snake_case on every surface: `effort_profile`, never `artemis.effort_profile` or
`effortProfile`. A requested factor this adapter cannot apply is refused rather than ignored:
silently dropping one is how two arms of a comparison both run the deployment default and still look
like a contrast. An unconfigured profile name is checked against `GET .../generation/effort-profiles`
*before* anything is created, because Artemis answers it with a 400 only once the run starts — by
which point a configuration mistake has already made an exercise and looks like a failed generation.
Both are configuration errors: they exit the adapter rather than being recorded as an attempt.

### The exercise format is a treatment, not a constant

`target.parameters` decides what Artemis is asked to build, and three of those settings change what
Hyperion generates rather than only how the result is packaged. Verified against the branch under
test:

| Parameter | Effect on generation |
| --- | --- |
| `static_code_analysis` | Adds a static-analysis clause to the agent system prompt, adds an SCA report-collection stanza to the generated `verify.sh`, and adds a verification gate that rejects a reference solution producing penalised findings. |
| `hidden_tests` | Sets a due date. A **null** due date makes the prompt require every hidden-variant cell to be `no`, and three later gates reject a test plan that hides anything, so leaving it unset forbids `AFTER_DUE_DATE` tests entirely. |
| `language`, `project_type` | The format itself. The branch's verifier supports `JAVA` with `PLAIN_MAVEN` or `MAVEN_MAVEN`. |

`max_points`, `difficulty`, `package_prefix` and `release_lead_ms` reach Artemis but no Hyperion code
path reads them; they are format metadata. `release_lead_ms` exists because Artemis treats a null
release date as already released and Hyperion refuses to generate into a released exercise.
`bonusPoints`, `includedInOverallScore`, `mode`, `showTestNamesToStudents`, `assessmentType`,
`allowOnlineEditor`, `allowOfflineIde`, `checkoutSolutionRepository`, and `channelName` are fixed for
the same reason: varying them would add a treatment dimension that cannot change what is generated.

The package name is derived from the attempt id, not the case title, so it is not an uncontrolled
per-case difference in the build context the agent reads. The draft title carries the attempt-unique
short name for a different reason: Artemis enforces per-course title uniqueness, so two arms of the
same case would otherwise collide on `titleAlreadyExists`. No Hyperion prompt reads the title, and a
GENERATE run replaces it with the first heading of the statement it writes, so the suffix does not
reach the agent.

The adapter rejects locally the combinations Artemis answers with a 400 — static code analysis with
sequential test runs, static code analysis with `FACT`, a project type for a language that declares
none, a missing project type for a language that declares some, and a package prefix for a language
that takes no package name — so an operator gets a configuration error rather than a 400 mid-campaign.
A deployment licence filter can narrow the project-type list further at runtime, so preflight against
the real instance remains the authority.

### OpenTelemetry collector

Run the pinned collector beside Artemis, with its OTLP ports reachable only from the Artemis
deployment and its evidence directory mounted read-only into the exgen adapter:

```bash
sudo install -d -m 0770 -o 10001 -g 10001 /tmp/exgen-otel-evidence
docker run --rm --name exgen-otel \
  --network ARTEMIS_PRIVATE_NETWORK \
  -v "$PWD/adapters/artemis/opentelemetry-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v /tmp/exgen-otel-evidence:/evidence:rw \
  otel/opentelemetry-collector-contrib@sha256:45392d534c1edcc809c2d112394029246bc679d2ae5ea7081414a1fc74f2c621
```

The `environment` command emits the complete, secret-free environment map that must be applied when
starting Artemis. It is derived from the same validated parameters consumed by the adapter, rather
than maintained as a second hand-written configuration. The result includes the OTLP endpoint,
100% sampling, content capture, a 1-second export schedule delay, disabled OTLP logs/metrics,
disabled hidden model retries, and the non-Langfuse standard exporter. Spring Boot's default
5-second schedule delay is ten times the harness's default quiescence window, so leaving it at the
default makes a complete trace look stalled.

The pinned collector config drops Artemis actuator polling through a `filter/actuator` processor.
That filter is span-scoped and therefore cannot select whole traces: the exgen correlation attribute
rides only on the job root span, and dropping an intermediate span of a retained trace makes the
harness reject the attempt as orphaned. Actuator spans can never belong to a Hyperion generation
trace, so they are the only safe thing to drop at the collector; volume containment for everything
else is the harness's job, which retains only spans of the correlated trace.

The equivalent Spring Boot 4 environment (the endpoint shown assumes the collector container is
named `exgen-otel` on the private network) is:

```bash
MANAGEMENT_LANGFUSE_ENABLED=false
MANAGEMENT_OPENTELEMETRY_ENABLED=true
MANAGEMENT_TRACING_SAMPLING_PROBABILITY=1.0
MANAGEMENT_TRACING_EXPORT_OTLP_ENABLED=true
MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_ENDPOINT=http://exgen-otel:4318/v1/traces
MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_OTLP_TRANSPORT=http
MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_SCHEDULE_DELAY=1s
MANAGEMENT_OPENTELEMETRY_INSTRUMENTATION_GEN_AI_CAPTURE_CONTENT=true
MANAGEMENT_LOGGING_EXPORT_OTLP_ENABLED=false
MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED=false
SPRING_AI_OPENAI_MAX_RETRIES=0
```

The preflight makes ordinary authenticated Artemis requests and then requires new collector output,
so a configured-but-broken exporter fails before collection. For each generation, the adapter takes
a byte cursor before remote mutation, waits for the ended job root span and a stable complete trace,
selects all spans sharing its trace ID, and verifies Spring AI call count, input/output usage, and
complete provider response IDs against Artemis's independent terminal accounting. Duplicate or
orphan spans, declared dropped data, missing traces, or disagreements fail the attempt closed. The
source byte range is hashed and the normalized `exgen.otel.genai.v4` trace is stored as a
digest-linked restricted diagnostic at
`telemetry/opentelemetry-trace.json`. The normalized `exgen.otel.genai.v4` profile also records
per-token-class attribute coverage and reconciles cache-read, cache-creation, and reasoning-output
tokens whenever the product or provider supplies an independently checkable total. Missing optional
breakdowns remain explicitly unavailable rather than being treated as zero.
It also reconciles Artemis's count of model-requested tool calls with fresh output `tool_call`
parts and records a fresh-output inventory for text, tool calls, and provider-exposed reasoning.
Rejected or truncated requests still count as requests; successful execution is a different claim.

Do not enable `management.langfuse` for benchmark capture: its custom exporter intentionally filters
the trace. Instead, the benchmark environment independently opts into standard
`gen_ai.input.messages` and `gen_ai.output.messages` — which, as the Upstream status table notes, is
a filter the branch adds. On `origin/develop` the only content filter is Langfuse-gated and emits the
older concatenated `gen_ai.prompt` / `gen_ai.completion`, so the `content_capture` contract below is
not satisfiable there at all.

`content_capture` has **no default and must be stated** in the parameters. It decides whether prompts
and completions are written into the evidence file, so the tier is a deliberate selection a campaign
records, not something it inherits silently — `docs/TELEMETRY.md` makes metadata-only the
cross-system default, and the restricted content tier is an explicit opt-in this study makes. Under
`content_capture: required`, every model span must contain valid, non-empty input and output message
arrays or the attempt fails closed. Under `forbidden`, the whole content attribute set must be
absent from every span of the captured trace. This validates what was actually exported rather than trusting
the declared Artemis environment. The content includes observable messages and tool calls, not
hidden chain-of-thought. It is sensitive restricted evidence and must be encrypted and access
controlled. The collector file must not rotate during a campaign; a truncation or rotation during
an attempt is detected and rejected. Pin the collector image digest in the treatment manifest and
keep the OTLP receiver and evidence mount private.

The Collector file exporter is alpha and does not promise stable JSON field names. Exgen contains
that risk by pinning the Collector image, testing the parser, hashing the consumed source segment,
and emitting its own versioned normalized evidence profile. See the cross-system authority,
correlation, privacy, and completeness rules in [the telemetry profile](../../docs/TELEMETRY.md).

If the Artemis deployment routes every Hyperion model call through OpenRouter, enable exact billing
reconciliation in the system parameters:

```json
{
  "cost_reconciliation": {
    "provider": "openrouter",
    "api_key_env": "OPENROUTER_API_KEY",
    "currency": "USD"
  }
}
```

The adapter looks up each complete Artemis provider request ID in OpenRouter's
[Generation API](https://openrouter.ai/docs/api-reference/get-a-generation), verifies that native
input, output, and cache tokens match the Artemis ledger, and stores a digest-linked restricted
reconciliation record. Exact OpenRouter billed cost replaces the Artemis static EUR estimate only
after this check. A missing ID, token disagreement, unavailable credential, or provider error fails
the attempt closed. The API key itself is never persisted.

Do not enable this for Logos or another provider. For a genuinely unbilled deployment, explicitly
configure input, output, and cached-input model rates as zero in Artemis; an absent price means
"unknown", not "free".

## Generator protocol

```bash
bun adapters/artemis/adapter.ts describe --json
bun adapters/artemis/adapter.ts generate --request REQUEST.json --output OUTPUT_DIRECTORY
bun adapters/artemis/adapter.ts recover --request REQUEST.json --output OUTPUT_DIRECTORY
```

Before any remote mutation the adapter atomically records a create intent. It then records the
exercise ID and job ID as soon as each becomes known. Recovery reconciles a lost setup response by
the course-unique short name, discovers a generation whose start response was lost through the
production status endpoint, and cancels the exact job. It never silently starts a second stochastic
sample.

A successful observation requires a terminal `DONE` event whose `completionStatus` is `SUCCESS` or
`NEEDS_REVIEW`, its exact `savedExerciseVersionId`, and template, solution, and test commit
identities that match that immutable snapshot. A `PARTIAL` completion is reported as a failed
generation with `partial` capture, not as an infrastructure failure: Artemis never records a saved
exercise version for it, so there is nothing to export.

### A run that was not accepted still leaves its candidate

`failed_artifact_capture: "partial"` is a claim the adapter has to back, so it fetches
`GET .../generate-exercise/artifacts` on a non-accepted **terminal** outcome. That endpoint returns
the candidate a terminal run produced but never saved — screened text, owner-only, bounded, and
expiring with the rest of the run's replay evidence (`terminal-replay-ttl`, `PT4H`).

A cancellation and an infrastructure failure are not terminal outcomes and are not fetched. The
runner ends such an attempt `cancelled` or `failed`, evaluation reads only `completed` attempts, and
the candidate would land in the attempt directory without appearing in `response.json` — evidence
nobody can read, bought with an HTTP round-trip on the cancellation path.

Three properties of it decide what the adapter does with it:

- **Retained, not persisted.** Nothing was committed and no exercise version exists, so there is no
  commit identity to pin and `verifyExportedRepositoryCommits` does not apply. The commit-pinned
  export path is for accepted runs only; this one pins on stated completeness and content.
- **Completeness is copied, not derived.** Any drop — bounds or secret-material screening — makes
  Artemis say `PARTIAL`, and whether a file was dropped is not discoverable from the file list. It
  maps onto the protocol's `capture.completeness`, except that a `PARTIAL` Hyperion completion
  outranks it: a run that generated only part of the exercise is not a complete capture however
  faithfully the retention endpoint answered.
- **The outcome does not move.** Hyperion did not accept this run. Retained artifacts give an
  evaluator something to score; they never turn a `failed` attempt into a `succeeded` one.

Only repositories that actually received a file are declared, because a declared artifact path has to
exist on disk and a candidate routinely has nothing for one of the three.
`retained_candidate.status` is always present rather than inferred from an absent field, and
separates the four outcomes a boolean would conflate: `captured`, `absent` (the ordinary 404 or an
empty payload), `other_job`, and `unavailable`. The fetch never raises: it is evidence about an
outcome that is already determined, so a bad payload, an unsafe path, or a breached artifact bound
becomes `unavailable` with a `retained_candidate.reason`, and the attempt keeps the status Hyperion
gave it.

The payload is JSON rather than an archive, which is the right shape here: the content is text by
construction, so a ZIP would reintroduce the traversal, symlink, ratio, ZIP64 and encryption surface
that `centralEntries` exists to defend against, for a payload that has none of it. Paths are still
checked and the byte and file-count bounds still apply — it arrives over the wire either way. The
whole payload is screened before the first write, so a breached bound leaves no half-written tree
for the evidence manifest to hash.

Repository exports are bounded before decompression and reject unsafe paths, duplicate names,
unsupported or encrypted compression, ZIP64 containers, excessive expansion, file counts, and total
size. Entries that declare Unix mode bits are additionally rejected when they describe a link or
special file; extraction never creates a symlink under any circumstances, so a symlink entry from a
non-Unix archive becomes an inert regular file rather than an escape.

### Measurement is evaluated separately from generation

The candidate and `artemis/terminal-status.json` are written before the measurement planes — provider
cost reconciliation and OpenTelemetry — are touched at all. A measurement failure therefore leaves
the analysable evidence on disk, and the outcome is reported through
`extensions.artemis.measurement.outcome` rather than appended to the prose `message`. Required
measurement is part of a successful attempt: a generated candidate with missing or invalid
measurement is `infra_failed`, while a prior Hyperion failure remains `failed` unless product
accounting is incomplete or contradictory.

| `outcome` | Meaning | Effect on attempt status |
| --- | --- | --- |
| `captured` | Every configured plane agreed. | Hyperion's outcome stands. |
| `disagreed` | The trace is capturable but contradicts Artemis's own accounting. | Fails closed as `infra_failed`, artifacts retained for diagnosis. |
| `product_accounting_incomplete` | Artemis never marked its own token accounting complete, so the cross-check had nothing to check against. | Fails closed as `infra_failed`, artifacts and trace retained. |
| `trace_unavailable` | The trace could not be obtained at all. | A Hyperion failure stays `failed`; a Hyperion success becomes `infra_failed` with the candidate still exported. |
| `cost_unverifiable` | The provider's billing records could not be reached. | Missingness, same rule, and no unverified amount is published as `cost`. |

The first two are separated without matching on error text: a capture that fails is retried with
usage verification disabled, and only a retry that then succeeds proves the trace itself was fine and
the cross-check was what disagreed.

`product_accounting_incomplete` is the one case where that retry would be a hole rather than a
diagnosis. Incomplete accounting is exactly the state a system that under-reports its usage produces,
so re-running the capture with `verify_usage` off would let the system under test switch off the
check designed to catch it. The trace is captured unverified and kept as evidence, but the attempt
fails closed. Configuring the telemetry plane at all is what makes this binding; an attempt that
configures no telemetry makes no measurement claim and still tolerates the gap through
`usage_accounting_gap`.

`extensions.artemis.cost_verified` is `true` only after a provider reconciliation actually succeeded.
`extensions.artemis.cost_reconciliation_configured` says whether one was ever requested, so
"not requested" and "requested and passed" are distinguishable rather than sharing one flag.

### Limits and model identity

`extensions.artemis.effective_limits` lists every Artemis knob that can end a run, each with a
`source`: `system_reported` when the status carried the value, `system_configured` when the operator
declared it in `server_limits`, and `unknown` when neither did. `unknown` is recorded positively —
a limit that bound a run and that nobody wrote down should be visible as such. Artemis today reports
only *which* limit bound, through `termination_reason`, never its value, so `server_limits` is how a
campaign gets numbers into the evidence.

`execution.effective_limits` carries every known limit with its source attached. The runner grants
`budget_status: non_binding` — the claim that the system's own guard bound before the declared budget
did — only from a `system_reported` value, so an operator's declaration is recorded beside it without
being able to earn that verdict. Since Artemis reports no limits today, everything in that block is
`system_configured` and no attempt can be called `non_binding` on this deployment.

`execution.effective_parameters` records the resolved exercise format and the model identifiers the
job used. The response `model` block is populated only when `model_provider` is declared: Artemis
reports which models a job used but never which endpoint served them, and an identifier such as
`openai/gpt-oss-120b` served by a local deployment would make the prefix a false provider claim.

This matters for the denominator. A Hyperion run that hits its step limit and ends `AGENT_ERROR` is
a generation-quality result and must be counted `failed`; letting a telemetry fault turn it into
`infra_failed` would silently drop a planned attempt from the analysis.

The evidence directory may contain prompts, provider request IDs, and diagnostic output. It stays
private and is never copied into the public release.

### Artemis limits that shape a campaign

These are behaviours of the Artemis under test, not adapter settings. Plan around them. Each bullet
says whether it is branch-only or already on `origin/develop`, because the two need different
planning: a branch-only limit disappears if the feature merges differently, a released one does not.

- **Sandbox slots default to zero, and the failure is silent** (branch-only).
  `artemis.continuous-integration.build-agent.max-generation-sandbox-slots` defaults to **0** — it is
  opt-in so that enabling Hyperion does not put generation load on exam-critical build agents. At 0
  the `InteractiveSandboxRelayHandler` bean is never created (`@Conditional`, slots > 0) and every
  generation call returns `HTTP 503 generationCapacityUnavailable`. What makes this expensive to
  diagnose is that the startup banner still advertises the feature as active — the banner reads only
  `hyperion.enabled` and the exercise-generation flag, never the slot count — and no capacity-refusal
  is logged, because the exception is translated to a response without reaching a warning path. Set
  `ARTEMIS_CONTINUOUSINTEGRATION_BUILDAGENT_MAXGENERATIONSANDBOXSLOTS` to **at least 2** for a
  harness concurrency of 1: one live run plus headroom while the previous session's container is
  still tearing down.
- **Hyperion token budget** (branch-only), measured against a real campaign. Artemis admits generation against
  rolling per-user, per-course, and global token budgets (`admission-max-tokens-per-user` defaults
  to 12,000,000 per `PT24H`, with `max-tokens-per-job` at 3,000,000). One observed generation on the
  development dataset consumed roughly **1.25 M tokens**, so the 19-case dataset is about **24 M** —
  double the branch's default per-user ceiling. A full-dataset campaign will hard-429 around case
  10 unless you raise `admission-max-tokens-per-user` or spread the run across accounts or days.
- **Status retention** (branch-only). The job status keeps at most 500 events and drops from index 1 once it
  overflows, so a long run legitimately loses its middle. The adapter re-aligns on the retained
  suffix, records an `artemis.events_truncated` journal record, and reports `dropped_event_count`
  rather than discarding the attempt. A history that changes in a way the cap cannot explain is
  still rejected.
- **Terminal status TTL** (branch-only). A finished job's replayable transcript expires after 900
  seconds, so recovery and usage reconciliation must run inside that window. Do not key "expired" on
  a 204, though: if a revert baseline still exists — 7-day TTL, and it does exist for exactly this
  adapter's case of an unreleased draft with no participations — the endpoint keeps returning **200**
  with an empty `events` list for up to a week. Absence of events, not absence of a response, is the
  signal.
- **Draft exercises only** (half released). `Exercise.isReleased()` treating a null release date as
  already released is on `origin/develop`; Hyperion's refusal to generate into a released exercise is
  branch-only. The adapter therefore creates every draft with a future release date. Do not remove
  it.
- **Title charset** (released). The charset rule and the whitespace collapse are both on
  `origin/develop`: Artemis rejects titles containing characters outside letters, marks, digits,
  `_`, `-`, and whitespace, and collapses runs of whitespace. Case titles carrying `(`, `)`, `:`,
  `.`, `/`, or `&` fail exercise setup with HTTP 400, so the adapter drops every character outside
  that class from the case title and collapses the remaining whitespace runs before appending the
  short name; an unsanitizable title falls back to `Exercise`. The title is cosmetic — case identity
  is the case ID and the short name is a digest of the attempt ID — and the unsanitized title stays
  on the record in the attempt's `request.json`. Separately, and branch-only, a `GENERATE` run
  started from a blank problem statement replaces the title with the first `# ` heading of the
  generated statement — written through a direct update that does **not** re-run title validation, so
  a generated title may contain characters setup would have rejected.
- **Accounting seal** (branch-only). Artemis seals a run's accounting only after it emits the
  terminal event, and reports the seal three-valued: `PENDING` is "not yet", `COMPLETE` is a total,
  and `INCOMPLETE` is a permanent lower bound. The adapter waits out `PENDING` only — settling on an
  `INCOMPLETE` seal that can never become `COMPLETE` spends budget to learn nothing — then records
  the gap through `usage_accounting_gap`
  rather than reporting zero. With a telemetry plane configured the attempt also fails closed — see
  *Measurement is evaluated separately from generation*. The wait is `accounting_settle_ms` clamped to
  what is left of the attempt's wall-time budget, and the same window bounds the error path, so a
  job that terminates near the Artemis `max-job-duration` cannot spend a settle window past the
  harness wall clock and have the runner kill a finished generation as a timeout.
  `post_cancel_budget_ms` bounds the cancel request only.

## Clean up

Prefer destroying the isolated deployment once evidence is sealed. On a reused development instance,
the guarded cleanup command deletes only exercises whose ID and exact short name appear in adapter
state beneath the given run directory:

```bash
bun adapters/artemis/campaign.ts cleanup \
  --parameters /tmp/artemis-parameters.json \
  --run-dir .exgen/runs/CAMPAIGN \
  --confirm-course-id 123
```

Pass `--dry-run` to report exactly what would be deleted without deleting anything. The command
reports a per-exercise outcome, continues past a failed delete rather than abandoning the run
half-finished, and exits non-zero if any delete failed.

Keep evaluator assets out of Artemis. Generated repositories, status events, prompts, and checkpoint
data stay private until the release process explicitly selects what may be published.

Any authenticated connection — password or bearer — requires HTTPS unless the host is loopback
(`localhost`, `127.0.0.0/8`, `[::1]`, or `0.0.0.0`), and response and artifact sizes are bounded by
the configured limits.
