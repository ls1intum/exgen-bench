# Artemis adapter

This adapter connects the generator protocol to the Artemis benchmark API for whole-exercise
generation and canonical verification. Artemis must implement the contract in
[`benchmark-api.openapi.yaml`](benchmark-api.openapi.yaml).

## Configuration

Copy [`parameters.example.json`](parameters.example.json) into the benchmark system's `parameters`
and set the Artemis URL, approach, and model profile. Credentials are referenced by
environment-variable name:

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

The adapter implements the standard generator commands:

```bash
bun adapters/artemis/adapter.ts describe --json
bun adapters/artemis/adapter.ts generate --request REQUEST.json --output OUTPUT_DIRECTORY
```

Its descriptor is `artemis@1` with revision `artemis-benchmark-v1`.

## Resume and evidence

The observation ID is the client attempt and idempotency ID. The adapter stores the remote run ID
under `OUTPUT_DIRECTORY/artemis/` before polling. Repeating the same observation in that directory
resumes the same remote run. Cancellation signals trigger a best-effort remote cancellation; state
remains available for reconciliation.

The evidence directory may contain prompts, provider identifiers, and diagnostics. It is part of
the private run evidence, not the public release.

## Canonical verification

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

[`metric-cards.example.json`](metric-cards.example.json) shows the required metric metadata.
Replace its planned validation entries with evidence from the frozen suite before a submitted
release.

Bearer authentication requires HTTPS except for loopback test servers. Response and artifact sizes
are bounded by the configured limits.
