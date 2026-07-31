# Artemis adapter

This adapter connects exgen-bench to the proposed Artemis API for complete exercise generation and
platform checks. Artemis must implement the API in
[`benchmark-api.openapi.yaml`](benchmark-api.openapi.yaml).

The API is a proposal and is not available in an unmodified Artemis instance. Related Hyperion
implementation: [Artemis PR #13156](https://github.com/ls1intum/Artemis/pull/13156).

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
bun adapters/artemis/adapter.ts recover --request REQUEST.json --output OUTPUT_DIRECTORY
```

Its descriptor is `artemis@1` with revision `artemis-benchmark-v1`.

## Continue a remote run

The stored observation ID also identifies the attempt to Artemis and prevents the same remote work
from starting twice. The adapter saves the Artemis run ID under `OUTPUT_DIRECTORY/artemis/` before
it checks progress. Repeating the same observation in that directory continues the existing remote
run. If the local result is uncertain, the runner invokes `recover`; the adapter finds the remote
run, requests cancellation, and waits for it to finish.

The evidence directory may contain prompts, provider request IDs, and diagnostic output. It remains
private and is not copied into the public release.

## Evaluate with Artemis

```bash
bun run cli evaluate artemis RUN_DIRECTORY \
  --parameters PARAMETERS.json \
  --evaluator-revision ARTEMIS_COMMIT \
  --evaluator-digest VERIFIER_SHA256 \
  --suite-id SUITE_ID \
  --suite-version SUITE_VERSION \
  --suite-digest SUITE_SHA256 \
  --profile artemis-java-v1
```

The server must return the requested evaluator and test-suite versions. The adapter rejects a
mismatch before recording the result. A rejected candidate is a quality failure; an error in the
verifier is a service failure and has no quality result.

[`metric-cards.example.json`](metric-cards.example.json) shows the required metric metadata.
Replace its planned validation entries with evidence from the frozen suite before a study release.

Bearer authentication requires HTTPS except for loopback test servers. Response and artifact sizes
are bounded by the configured limits.
