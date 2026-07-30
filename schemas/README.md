# Evaluation corpus — data contract (JSON Schema)

These schemas define the on-disk **corpus** the Tier-1 evaluation harness consumes. See `../SYSTEM-DESIGN.md` §3 for context.

## Files & who produces them

| File | Instance | Produced by | Purpose |
|------|----------|-------------|---------|
| `candidate-record.schema.json` | `candidates/<id>/record.json` | **Generation experiment (Artemis/Hyperion side)** | One record per **saved** exercise (outcome `SUCCESS`/`NEEDS_REVIEW`) |
| `attempt-log.schema.json` | `attempts/<cell>.json` | **Generation experiment (Artemis/Hyperion side)** | All *k* attempts per `(input, model, variant)` cell, incl. not-saved (for yield: H1/H2a/pass@k) |
| `input-spec.schema.json` | `inputs/<input_id>/spec.json` | **Evaluation/benchmark side** | Reference info per input: required constructs (#6), complexity band (#7), item-writing rules (#12), golden ref (#9/#10/#11) |
| `common.schema.json` | — | shared | `$defs` referenced by the other three |

All four files must sit in the **same directory**; the cross-file `$ref`s are relative.

## Corpus layout

```
corpus/
  inputs/<input_id>/spec.json                       # input-spec.schema.json
  inputs/<input_id>/golden/{solution,template,tests,problem-statement.md}   # optional
  candidates/<candidate_id>/record.json             # candidate-record.schema.json
  candidates/<candidate_id>/{problem-statement.md, template/, solution/, tests/}
  attempts/<input_id>__<model>__<variant>.json      # attempt-log.schema.json
```

## Invariants the harness checks (beyond JSON Schema)

- **Reconciliation:** every attempt with `outcome ∈ {SUCCESS, NEEDS_REVIEW}` has a `candidate_id` that resolves to a `candidates/<id>/` directory whose `record.json` has the matching `input_id`/`model`/`variant`/`run`.
- **Run uniqueness:** `run` values are unique within a cell and (SHOULD) lie in `1..k`.
- **Oracle parity:** for each saved candidate, the harness independently rebuilds and asserts its `#1–#3` verdict equals `hyperion_verdict` (a mismatch is a flagged anomaly, §9).
- **Yield denominator:** `k` is the denominator for save-rate / pass@k even if fewer than `k` attempts were emitted.

## Deployability mapping (for yield)

`deployable(attempt) := outcome ∈ {SUCCESS, NEEDS_REVIEW}`. `NOT_SAVED` and `PARTIAL` are not deployable; `PARTIAL` is additionally flagged for manual reconciliation.

## Validating an instance

**Node / ajv-cli:**
```bash
npm i -g ajv-cli ajv-formats
ajv validate -c ajv-formats \
  -r common.schema.json -r input-spec.schema.json -r attempt-log.schema.json \
  -s candidate-record.schema.json -d "path/to/record.json"
```

**Python (`jsonschema` ≥ 4.18 + `referencing`):**
```python
import json, glob
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

resources = []
for f in glob.glob("schemas/*.schema.json"):
    doc = json.load(open(f))
    resources.append((doc["$id"], Resource.from_contents(doc)))
registry = Registry().with_resources(resources)

schema = json.load(open("schemas/candidate-record.schema.json"))
Draft202012Validator(schema, registry=registry).validate(json.load(open("record.json")))
```

Each schema also carries a valid `examples[0]` you can lint against as a smoke test.

## Versioning

Every instance carries `schema_version` (currently `"1.0"`). Additive changes that stay backward-compatible keep the version; breaking changes bump it. Unknown fields are rejected (`additionalProperties: false`); use the `extra` object on each root for non-standard data.
