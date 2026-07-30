# Artemis adapter

This adapter connects the generator protocol to Artemis whole-exercise generation and canonical
verification.

## API modes

| Mode | Use | Server support |
|---|---|---|
| `research` | Durable generation and verification with structured evidence | Proposed in [`research-api.openapi.yaml`](research-api.openapi.yaml); requires the matching Artemis implementation |
| `legacy-pilot` | Limited generation pilot against PR #13156 | Mutates one isolated exercise per attempt and captures artifacts only after successful persistence |

`research` is the default. The two modes are explicit; the adapter does not fall back between them.
The legacy mode cannot capture failed workspaces or confirm that a requested seed was honored, so it
is not suitable for a confirmatory campaign.

## Configure generation

Use [`parameters.example.json`](parameters.example.json) with the research adapter. The limited
legacy bridge has a separate [`legacy-parameters.example.json`](legacy-parameters.example.json).
Credentials are referenced by environment-variable name:

```json
{
  "auth": {
    "type": "bearer",
    "token_env": "ARTEMIS_API_TOKEN"
  }
}
```

The benchmark runtime must pass that variable to the adapter process. Do not put its value in the
configuration.

Each mode has its own executable and descriptor:

```bash
# research · artemis@1 · revision artemis-research-bridge-v1
bun adapters/artemis/adapter.ts describe --json
bun adapters/artemis/adapter.ts generate --request REQUEST.json --output OUTPUT_DIRECTORY

# legacy pilot · artemis-legacy-pilot@1 · revision artemis-legacy-pilot-bridge-v1
bun adapters/artemis/legacy-adapter.ts describe --json
bun adapters/artemis/legacy-adapter.ts generate --request REQUEST.json --output OUTPUT_DIRECTORY
```

Research mode uses the observation ID as its client attempt and idempotency ID. It stores the remote
run ID before polling, reconciles an uncertain start, and retains sequenced events and provenance.
Legacy mode mutates the configured `exercise_id` and fetches the saved exercise at its recorded
version and repository commits. Use it only for a single-attempt pilot against a dedicated
exercise; its API does not provide the isolation or failed-workspace capture required for a
campaign.

## Resume and evidence

The adapter stores remote state under `OUTPUT_DIRECTORY/artemis/`. Repeating the same observation in
that directory resumes its remote run. Cancellation signals trigger a best-effort remote
cancellation; state remains available for reconciliation.

The Artemis evidence directory may contain prompts, provider identifiers, and diagnostics. It is
part of the private run evidence, not the public release.

## Canonical verification

Canonical verification is available only in `research` mode:

```bash
bun run cli evaluate-artemis RUN_DIRECTORY \
  --parameters PARAMETERS.json \
  --evaluator-revision ARTEMIS_COMMIT \
  --evaluator-digest VERIFIER_SHA256 \
  --suite-id SUITE_ID \
  --suite-version SUITE_VERSION \
  --suite-digest SUITE_SHA256 \
  --profile artemis-java-v1
```

The server must echo the evaluator and suite identities. The adapter rejects mismatches before
recording a verdict. A verifier rejection is a quality failure; a verifier error is an
infrastructure failure without a quality verdict.

[`metric-cards.example.json`](metric-cards.example.json) shows the required metric metadata. Replace
its planned validation entries with evidence from the frozen suite before a submitted release.

Bearer authentication requires HTTPS except for loopback test servers. Response and artifact sizes
are bounded by the configured limits.
