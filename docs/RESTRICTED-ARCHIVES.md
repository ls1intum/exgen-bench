# Restricted operational archives

Generation traces, event journals, checkpoints, and model content are diagnostic evidence, not
public benchmark results. Exgen packages a complete run in a restricted
[BagIt 1.0](https://www.rfc-editor.org/rfc/rfc8493) archive so custody transfers can verify the
inventory and SHA-256 digests without teaching each storage system an exgen-specific format.

```bash
bun run cli archive create .exgen/runs/my-run \
  --output .exgen/restricted/my-run \
  --id my-run \
  --retention-until 2027-07-31 \
  --content model-content
bun run cli archive verify .exgen/restricted/my-run
```

The `archive create` command takes the run coordinator lock for the duration of the copy; the
exported `createRestrictedArchive` function does not, so any other caller must hold the lock itself.
Creation rejects links and special files, bounds the source walk, copies into a mode `0700`
temporary directory beside the target, rehashes and `fsync`s every copy, and atomically renames the
finished bag. Verification rejects undeclared payload files, unsafe or duplicate manifest paths,
linked tag files, digest mismatches, and inconsistent payload counts or sizes. The declaration
records the classification, retention date, content status, and reasoning policy.

RFC 8493 section 2.4 requires a BagIt 1.0 tool to support both SHA-256 and SHA-512 and recommends
enabling SHA-512 by default when creating bags. Exgen writes both: every bag carries
`manifest-sha256.txt` and `manifest-sha512.txt` with matching tag manifests, and verification checks
every manifest present in a supported algorithm. Manifest filepaths are percent-encoded per RFC 8493
section 2.1.3, which encodes `%`, CR and LF and only those. `bagit-python` and `bagit-java` decode
`%0A` and `%0D` but never `%25`, so a payload path containing a literal `%` is written conformantly
by exgen and then resolved to a different, missing file by both: such a bag will not round-trip
through them. Verification also accepts the optional `fetch.txt` and additional algorithm manifests
RFC 8493 permits.

## Security boundary

BagIt provides integrity and transfer completeness, **not confidentiality**. A restricted bag must
be stored in an access-controlled, encrypted-at-rest system, transferred over an authenticated
encrypted channel, and deleted according to its declared retention date. Use the organization's
KMS-backed object store, encrypted volume, or approved encrypted transport rather than adding a
repository-specific cryptosystem. Local Unix permissions are defense in depth, not proof of storage
encryption.

Raw prompts and outputs can contain personal data, credentials, copyrighted text, or hidden study
material. Metadata-only telemetry remains the general default. When a preregistered study enables
content, access to the restricted bag must be auditable and the public release must contain only
normalized results and non-sensitive provenance. The archive may retain reasoning summaries or
reasoning blocks that the provider explicitly returned; it does not obtain or infer hidden
chain-of-thought.

## Provenance and release separation

The bag preserves every file of the run, byte for byte, including any run-root
`evidence-manifest.json`. It does not preserve empty directories: BagIt payloads are file
inventories, so a run directory that exists but holds no files (`.work/`, for example) is absent
from the bag. The ordinary release exporter remains the public, normalized data path and does not
copy restricted diagnostics. Artifact, telemetry, evaluation, and price-table identities should be
pinned in the run before archiving; the SHA-256 and SHA-512 manifests then let a custody recipient
detect any later substitution or truncation of the archived bytes. They are file-integrity
manifests, not build provenance: exgen produces no signed attestation of how the run was made.

CI validates bags produced by the real CLI with `bagit-python` in both directions: a bag with
ordinary payload names must be accepted by the reference implementation, and a bag whose payload
name contains a literal `%` must be rejected by it and accepted by exgen — so the divergence above
is asserted rather than assumed, and CI fails if it ever silently closes.
