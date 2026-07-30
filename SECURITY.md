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
- Formal evaluators must run without model/API credentials, home-directory mounts, Docker socket,
  or network access.
- Configuration stores environment-variable **names**, never credential values. Result bundles,
  logs, manifests, and fixtures must not contain secrets.

## Formal-run baseline

Use a disposable Linux VM plus a digest-pinned non-root OCI container with read-only root,
dedicated tmpfs workspace, network disabled, all capabilities dropped, `no-new-privileges`,
seccomp, process/CPU/memory/file/output/wall limits, and reliable cleanup of descendant processes.

Artifact ingestion rejects absolute paths, traversal, symbolic links, hard links in evaluator
inputs, and special files. Adapter logs, artifact files, HTTP responses, retries, requests, and wall
time are bounded.

## Credential hygiene

If a credential appears in an issue, chat, log, or terminal transcript, rotate it. Never commit
`.env` files or put credentials in benchmark configuration.
