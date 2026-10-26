# Tier 3 expert rating

**Status: planned.** This directory holds the place of the expert rating in the repository and
contains no implementation.

Tier 3 is the ground truth the [Tier 2 judge](../tier2-judge/README.md) is validated against, and
nothing else. An instructor rates already-generated exercises; nobody authors one. The expert answers
the same checklist as the judge and sees the same material at the same point, so a disagreement
reflects judgement, not information. The ratings cover:

- a small calibration set, on which the judge's prompts and the checklist wording may be tuned;
- a held-out validation set, on which the judge is frozen and its agreement is measured per
  dimension;
- optionally, a second expert on part of the validation set, for an expert-to-expert baseline.

The dimensions are those of the judge's [suite](../tier2-judge/llm-judge/SUITE.md). Tier 1 detectors
are not validated here: the study team checks their precision separately.

Tier 3 is not an evaluator. It has no `tool.yaml`, so `exgen tools` does not list it and no
evaluation command runs it.
