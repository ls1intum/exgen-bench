# LLM judge suite (skeleton)

The Tier 2 judge will score a complete candidate exercise — statement, template, solution and
tests together — against a rubric, using a language model as the rater. It is a separate instrument
from the Tier 1 tools: it is run, versioned and reported on its own and is never combined with them.

This version is a skeleton. It speaks evaluation protocol v1 and declares the rubric metrics below,
but reports every one as `not_applicable`. Its gate is null, so it cannot decide `strict_success`.

| metric | intended meaning |
| --- | --- |
| `judge.statement_clarity` | whether a student could understand the task from the statement alone |
| `judge.task_solution_alignment` | whether the reference solution does what the statement asks |
| `judge.test_adequacy` | whether the tests would catch a plausible incorrect solution |
| `judge.pedagogical_fit` | whether the exercise practises the concept and level the brief asks for |
| `judge.overall` | the rater's overall judgement of the exercise |

The dimensions are placeholders. They are to be fixed together with the instructor expert survey
the judge will be calibrated against, and every judge metric stays `exploratory` until its agreement
with blinded expert ratings has been measured.
