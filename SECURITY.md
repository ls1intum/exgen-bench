# Security policy

## Supported status

The project has no security-supported stable release. Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/ls1intum/exgen-bench/security/advisories/new),
not a public issue. If the GitHub form is unavailable, use the IT Security route in
[TUM SafeSignal](https://safesignal.tum.de/).

## Trust boundaries

- The local `command` backend executes a configured adapter with the current user's permissions. It
  is for trusted development adapters only.
- Generated exercise artifacts and their build logic are untrusted. Do not execute them directly on
  a workstation.
- Candidate build and test processes must run without model credentials, home-directory mounts,
  Docker socket, or unrestricted network access.
- Artemis evaluation orchestration runs in a bounded child process that is forcibly reaped on
  timeout. Artemis must separately isolate and terminate the untrusted candidate workload in its
  verifier infrastructure. Other in-process evaluator executors are trusted and require
  cooperative cancellation.
- Configuration stores environment-variable **names**, never credential values. Result bundles,
  logs, manifests, and fixtures must not contain secrets.

## Formal-run baseline

Use a disposable Linux VM plus a digest-pinned non-root OCI container with read-only root,
dedicated tmpfs workspace, all capabilities dropped, `no-new-privileges`, seccomp,
process/CPU/memory/file/output/wall limits, and reliable cleanup of descendant processes.
Candidate build and test sandboxes run with network disabled. A generator or evaluator
orchestrator that calls a remote service needs `bridge` networking plus an external egress
allowlist for its declared endpoint; the container engine's bridge network is not an allowlist.

Artifact ingestion rejects absolute paths, traversal, symbolic links, hard links in evaluator
inputs, and special files. The runner bounds logs, protocol files, HTTP responses in the included
adapters, and ingested artifacts. Formal infrastructure must also enforce a filesystem quota while
the generator is writing.

## Credential hygiene

If a credential appears in an issue, chat, log, or terminal transcript, rotate it. Never commit
`.env` files or put credentials in benchmark configuration.
