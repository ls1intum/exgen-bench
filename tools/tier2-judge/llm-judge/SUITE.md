# LLM judge suite (skeleton)

The Tier 2 judge is designed to rate the didactical quality of a candidate exercise with a language
model. It answers the same yes/no checklist as the [Tier 3 expert](../../tier3-expert-rating/README.md),
and a roll-up rule, pre-registered before the study, derives one verdict per dimension from the item
answers. The rating
material, for the judge and the expert alike, is the brief, the statement, the template and a
student-facing test overview; neither reads the test code or the reference solution, whose
correctness Tier 1 certifies.

This version is a skeleton. It speaks evaluation protocol v1 and declares the metrics below, but
reports every one as `not_applicable`. It has no acceptance gate, so its `strict_success` only
records that it answered.

| metric | value | question |
| --- | --- | --- |
| `judge.clarity` | `met`, `partially_met`, `not_met` | Is every required behaviour stated unambiguously, and is the statement easy to understand at the target level? |
| `judge.solvability` | same | Do the statement and template give the student everything needed without seeing the tests? |
| `judge.objective_alignment` | same | Does the exercise practise and require the concept the brief names, and honour the brief? |
| `judge.difficulty_fit` | same | Are the difficulty and the amount of work right for the target level? |
| `judge.scaffolding` | same | Does the template give the right support, and do the tasks form useful steps? |
| `judge.feedback_quality` | same | Does a failing test's name and message tell the student what is wrong, without giving the solution away? |
| `judge.readiness` | 1–5 | How much work would deployment take, from 5 (deploy as is) to 1 (discard)? |

The checklist items, the critical items and the roll-up rule are open decisions. Every judge metric
stays `exploratory` until its agreement with the Tier 3 expert has been measured on a held-out set,
and a dimension that does not reach the agreement threshold stays expert-only.
