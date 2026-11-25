# LLM judge suite (skeleton)

This Tier 2 worker speaks evaluation protocol v1 and declares the metrics below. It reports
each metric as `not_applicable`. It has no acceptance gate, so `strict_success` records that
the worker answered.

The [staged Expert Study Judge](STAGED-JUDGE.md) is a separate program. It answers the six
exercise judgments from the blinded survey material, part by part. The Tier 2 worker receives
exgen run artifacts.

| metric                      | value                             | question                                                                                                       |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `judge.clarity`             | `met`, `partially_met`, `not_met` | Is every required behaviour stated unambiguously, and is the statement easy to understand at the target level? |
| `judge.solvability`         | same                              | Do the statement and template give the student everything needed without seeing the tests?                     |
| `judge.objective_alignment` | same                              | Does the exercise practise and require the concept the brief names, and honour the brief?                      |
| `judge.difficulty_fit`      | same                              | Are the difficulty and the amount of work right for the target level?                                          |
| `judge.scaffolding`         | same                              | Does the template give the right support, and do the tasks form useful steps?                                  |
| `judge.feedback_quality`    | same                              | Does a failing test's name and message tell the student what is wrong, without giving the solution away?       |
| `judge.readiness`           | 1–5                               | How much work would deployment take, from 5 (deploy as is) to 1 (discard)?                                     |

The checklist items, the critical items and the roll-up rule are open decisions. Every judge metric
stays `exploratory` until its agreement with the Tier 3 expert has been measured on a held-out set,
and a dimension that does not reach the agreement threshold stays expert-only.
