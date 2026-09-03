# Out-of-process evaluators

`exgen evaluate process` runs any evaluator that implements evaluation protocol v1. The command is
approach- and platform-independent: Artemis, its database, and its verifier are not part of this
boundary. A process receives one
[`evaluation-request`](../schemas/protocol/evaluation-request.schema.json) JSON document on stdin
and must write exactly one
[`evaluation-response`](../schemas/protocol/evaluation-response.schema.json) JSON document to
stdout. Bounded diagnostic logs may go to stderr.

## Run one

```bash
bun run cli evaluate process .exgen/runs/quickstart \
  --config examples/process-evaluator/config.yaml
```

The tiered measurement evaluators live in [`evaluators/`](../evaluators/README.md) and each ship an
`evaluator.yaml` for this command. They are designed to run **side by side over the same immutable
candidate**, each into its own journal; `exgen release create` accepts `--journal` once per evaluator
and requires `--authoritative-evaluator` to say which one decides `strict_success`.

## Configuration contract

The strict, versioned configuration schema is published as
[`process-evaluator-config.schema.json`](../schemas/protocol/process-evaluator-config.schema.json).
It binds the evaluator and suite identities, requested metrics, command, working directory,
environment references, and an optional recovery command. `execution` carries hard upper bounds:
concurrency at most 64, `timeout_ms` and `recovery.timeout_ms` at most 24 hours,
`termination_grace_ms` at most 5 minutes, and each input/response/log byte limit at most 1 GiB.
Relative working directories are resolved from the configuration file; relative command arguments
therefore run from that directory. `{bun}` resolves to exgen's pinned Bun executable.

### Environment references

`process.env` is not copied wholesale. The evaluator receives an allowlisted operating-system
baseline — `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` — plus only the declared mapping from child
names to host environment-variable names:

```yaml
process:
  argv: ["podman", "run", "--rm", "evaluator@sha256:..."]
  cwd: "."
  env:
    EVALUATOR_TOKEN: HOST_EVALUATOR_TOKEN
```

Values referenced through `process.env` never enter the configuration, configuration digest, CLI
summary, or journal: the schema constrains those values to host variable *names*, and only the name
is stored. This guarantee does not extend to `process.argv`, which is recorded verbatim in the
configuration digest and the journal — never put a secret in an argument. Exgen derives
`evaluator.configuration_digest` from the complete secret-free configuration and rejects a declared
digest that does not match. Formal studies should also pin the implementation or image digest and
archive the exact configuration and suite manifest. Environment references are for credentials only;
every setting that can change evaluation semantics must be explicit in the secret-free configuration
or a content-digested manifest.

### Repointing an evaluator at a different suite

Two settings are resolved against things that are easy to move apart, and getting either wrong
produces an infrastructure failure per candidate rather than a single clear error.

**`process.cwd` is resolved relative to the configuration file, not to the directory you run from.**
A configuration that lives beside its evaluator can therefore say `cwd: "."`. A copy of that
configuration placed elsewhere — the usual way to point an evaluator at a different suite — cannot,
because `.` now names the directory holding the copy. Point `cwd` back at the directory that holds
the entry point. Exgen checks a relative script argument against the resolved working directory when
the configuration loads, so this fails once, by name, before any candidate is evaluated.

**`suite.id`, `suite.version` and `suite.digest` must equal the identity the suite declares about
itself**, not the identity of the evaluator that reads it. For a reference-set suite that is the
`package.id`, `package.version` and `digest` of the reference set the evaluator was pointed at:

```yaml
# reference-set.yaml declares these; the evaluator configuration has to repeat them exactly.
suite:
  id: programmierprojekt-validation
  version: "0.5.0"
  digest: 85a5242c…
```

An evaluator that finds a mismatch rejects every candidate with `evaluation suite does not match
reference set <id>@<version> (<digest>)`, and that message carries the identity it expected — copy
it from there. The check is deliberate: it prevents a run from silently scoring candidates against a
reference set that has moved on, which is why the digest is part of the comparison rather than a
comment.

### Journal and recovery

The journal is append-only. Re-running the same command reuses terminal quality outcomes without
starting evaluator work. `--retry-infrastructure` retries only previous infrastructure failures for
the same immutable candidate and retains their history; it never retries a quality rejection. An
evaluator that starts durable remote work must configure `process.recovery`. Recovery receives the
same request on stdin and must reconcile or cancel that evaluation before exiting successfully. A
failed recovery leaves the evaluation pending instead of guessing its outcome.

## Why the baseline is this small

`HOME` is in the environment baseline deliberately, because container runtimes read credentials from
it — the `podman` example needs `$HOME/.config/containers/auth.json`. It is the most credential-rich
variable exgen passes through, and an evaluator you do not trust can read every registry, cloud, and
SSH credential the invoking user has. Run untrusted evaluators under a dedicated user or a runtime
that does not inherit `HOME`.

## Isolation is not provided

The process backend supervises and reaps children, but it is not a generated-code sandbox. The
public example is a development fixture only. Formal evaluators should invoke a digest-pinned,
network-restricted OCI runtime or another independently attested sandbox, keep sealed suite assets
outside the generator environment, and emit only schema-valid bounded evidence.
