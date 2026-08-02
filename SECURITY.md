# Security policy

## Supported versions

No tagged release currently receives security updates. Reports affecting `main` are accepted
through
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
- A process evaluator runs in a bounded child process that is forcibly reaped on timeout. It
  receives an allowlisted environment plus the variables its configuration declares, never the
  benchmark process's own environment. The built-in `bundle` evaluator runs in process, is trusted,
  and requires cooperative cancellation.
- Configuration stores environment-variable **names**, never credential values. Result bundles,
  logs, manifests, and fixtures must not contain secrets.
- Restricted archives are integrity-protected, not confidential. Encrypt and access-control them
  separately; see the [restricted-archive guide](docs/RESTRICTED-ARCHIVES.md).

## Minimum isolation for a formal study

Run generated code in a disposable Linux VM and a container that has:

- an image pinned by digest and a non-root user;
- a read-only root filesystem and a dedicated temporary workspace;
- all Linux capabilities dropped, `no-new-privileges`, and a seccomp profile;
- limits for processes, CPU, memory, files, output, and elapsed time; and
- reliable cleanup of child processes.

Disable networking for candidate builds and tests. A generator or evaluator that calls a remote
service needs bridge networking and a separate outbound allowlist for its declared endpoint. A
container engine's bridge network does not provide that allowlist.

Artifact ingestion rejects absolute paths, traversal, symbolic links, hard links in evaluator
inputs, and special files. The runner bounds logs, protocol files, HTTP responses in the included
adapters, and ingested artifacts. Formal infrastructure must also enforce a filesystem quota while
the generator is writing.

## Credential hygiene

If a credential appears in an issue, chat, log, or terminal transcript, rotate it. Never commit
`.env` files or put credentials in benchmark configuration.
