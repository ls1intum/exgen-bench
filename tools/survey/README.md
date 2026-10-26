# Instructor expert survey

**Status: planned.** This directory reserves the place of the survey tool in the repository; it
contains no implementation yet.

The survey will collect blinded instructor ratings of candidate exercises. Those ratings are the
reference the model-assisted Tier 1 metrics and the Tier 2 judge are validated against: until a
model-based metric's agreement with them has been measured, its metric card stays
`validation.status: planned` and its tier stays `exploratory`.

The survey is not an evaluator. It has no `tool.yaml`, so `exgen tools` does not list it and no
evaluation command runs it.
