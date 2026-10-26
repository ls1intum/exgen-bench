# Expert study on generated Artemis exercises: instrument

Version 1. Generated from [`instrument.yaml`](instrument.yaml) by `bun run survey:instrument`; edit the YAML, not this file.

## Materiality rule

> Answer **No** if the problem would plausibly cost a student at the target level noticeable time, lead to a wrong submission, or send them to a tutor. A cosmetic issue that does none of these is **Yes**.

## About you

We use your answers to describe the group of raters and to interpret differences between ratings. We store them under your pseudonymous rater ID.

**B1.** Your current role

Tick all that apply:

- `professor` Professor or lecturer
- `postdoc` Postdoc
- `phd` PhD student or teaching assistant
- `tutor` Student tutor
- `other` Other → Your role

**B2.** Years of experience in teaching or tutoring programming at university level

Choose one:

- `under_1` Less than 1
- `1_to_2` 1 to 2
- `3_to_5` 3 to 5
- `6_to_10` 6 to 10
- `over_10` More than 10

**B3.** Course levels you have taught or tutored

Tick all that apply:

- `introductory` Introductory programming (first year)
- `advanced` Advanced programming or algorithms and data structures
- `software_engineering` Software engineering
- `other` Other → Course level

**B4.** Number of programming exercises you have created or substantially revised (on any platform)

Choose one:

- `none` 0
- `1_to_5` 1 to 5
- `6_to_20` 6 to 20
- `over_20` More than 20

**B5.** Your experience with Artemis

Tick all that apply:

- `none` None
- `student` As a student
- `tutor` As a tutor (assessing submissions, answering questions)
- `editor` As an editor or instructor (creating or editing programming exercises)

**B6.** Your proficiency in Java, the programming language of the exercises

Choose one (1 = basic, 5 = expert):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**B7.** How often do you use AI tools to create teaching material?

Choose one:

- `never` Never
- `tried` Tried once or twice
- `occasionally` Occasionally
- `regularly` Regularly

**B8.** “AI-generated exercises can, in principle, be suitable for teaching.”

_This item records your general attitude towards AI-generated material, so that we can take it into account in the analysis. Please answer spontaneously._

Choose one (1 = strongly disagree, 5 = strongly agree):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

## Introduction

### Purpose of the study

Thank you for taking part. We study how well an AI-based pipeline generates programming
exercises for Artemis. You will rate several exercises, each written for a different phase of
a course. Automated checks already cover correctness. We therefore ask for your view as an
instructor on the didactical quality of each exercise.

Neither you nor the other raters know which model generated the exercises. We store your
answers under a pseudonymous ID. Please do not discuss the exercises with anyone until we
inform you that the study has closed.

### How a rating works

You rate each exercise in four parts. Each part adds material:

| Part | You see                                                   | You rate                                                  |
| ---- | --------------------------------------------------------- | --------------------------------------------------------- |
| A    | Brief, problem statement                                  | Clarity                                                   |
| B    | + template repository, diff between template and solution | Solvability, objective alignment, difficulty, scaffolding |
| C    | + test names and failure messages                         | Feedback quality, readiness (first rating)                |
| D    | + automatic findings                                      | The findings, readiness (second rating)                   |

The brief describes what the instructor asked for, including topic, target level, course
phase, and constraints. The diff shows what the student has to write, and you do not need to
check it line by line. The test overview shows only what students see in Artemis and does not
contain the test code. You cannot go back to an earlier part. If later material changes your
view, you can note this in the free-text field at the end.

### Answering the items

You answer each item with Yes or No, and a few items also offer N/A. If you answer No, please
note briefly where the problem is. For borderline cases, the materiality rule applies:

> Answer **No** if the problem would plausibly cost a student at the target level noticeable time, lead to a wrong submission, or send them to a tutor. A cosmetic issue that does none of these is **Yes**.

| Situation                                                                                                                  | Item | Answer | Reason                                |
| -------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ------------------------------------- |
| "recieve" is misspelled in the statement                                                                                   | CL2  | Yes    | Cosmetic issue                        |
| The statement asks for the average, but the tests expect two decimal places rounded half up                                | SO1  | No     | Leads to a wrong submission           |
| The statement says "ignore invalid entries" without defining whether an empty name is invalid, and a test checks this case | CL1  | No     | Two reasonable readings               |
| The test `countsOnlyActiveMembers` fails with "expected: <3> but was: <0>"                                                 | FB1  | Yes    | The test name explains the problem    |
| Several tests are named `test1` to `test5` and have no messages                                                            | FB1  | No     | The student cannot tell what is wrong |

### Meaning of the readiness levels

The readiness items ask how much work you would need to deploy the exercise to the target
students. The following examples serve as anchors:

| Level             | Meaning                                     | Typical example                                                                                  |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 5: Deploy as is   | No change needed                            | You would publish the exercise today.                                                            |
| 4: Minor edits    | Wording or formatting of the statement only | You clarify a sentence or add the expected output format to the statement.                       |
| 3: Moderate edits | Local changes, the design stays             | You add failure messages to a few tests, rename a misleading stub, or fix one rule and its test. |
| 2: Major revision | Parts must be redesigned                    | The template already solves the core concept, or half of the tasks have no tests.                |
| 1: Discard        | Writing from scratch is faster              | The exercise targets a different topic or level.                                                 |

Please rate your own effort as an instructor. The other items cover the effort of students.

## Practice exercise

We do not analyse the practice exercise. It lets you practise the items and shows how we interpret them. Afterwards, the tool shows our answers and the reasons for them. If your answers differ, please read the explanations. You do not need to change anything.

Items: CL1, SO1, FB1, RD1, asked with the brief, statement, template, diff and test overview open.

## Rating

Answer as an instructor deciding whether to give this exercise to students at the target level and course phase stated in the brief.

### Part A: Problem statement

_Open now: the brief and the problem statement._

**CL1.** Is every required behaviour stated so that only one reasonable reading exists?

_Look for:_ a rule two competent students would implement differently ("sort the items" without key or direction, an inclusive or exclusive bound); an example whose result does not follow from the stated rule.

Choose one:

- `yes` Yes
- `no` No → Where

**CL2.** Is the statement easy to understand for a student at the target level?

_Look for:_ undefined jargon; requirements buried in the narrative; a statement much longer or denser than the task warrants.

Choose one:

- `yes` Yes
- `no` No → Where

### Part B: Template and diff

_Open now: the template repository and the diff between template and solution. Skimming the template is enough: which files are given, which stubs the student fills in, and what the comments say. The diff shows what the student has to add or change. You do not need to check it line by line._

**SO1.** Do the statement and template tell the student everything needed to produce the expected results, without seeing the tests?

_Look for:_ an edge case mentioned without its expected result; an output that must match exactly (message text, number format, ordering) but is not given verbatim.

Choose one:

- `yes` Yes
- `no` No → Where

**OA1.** Does the exercise practise the concept or learning objective named in the brief?

Choose one:

- `yes` Yes
- `no` No → Where

**OA2.** Must the student actually apply the target concept to solve the task?

_Look for:_ the concept is already implemented in the template; a plain approach solves the task equally well and the statement does not rule it out (a recursion task solvable with a simple loop).

Choose one:

- `yes` Yes
- `no` No → Where
- `na` N/A, the brief names no specific construct or technique

**OA3.** Does the exercise honour the explicit requirements of the brief?

_Look for:_ a requested diagram, edge case, determinism constraint, given type, or audience that the exercise ignores.

Choose one:

- `yes` Yes
- `no` No → Unmet requirement

**OA4.** Is the scenario sensible and motivating for the task?

_Look for:_ a context bolted onto an unrelated computation; contrived rules presented as realistic; wrong domain facts; a scenario that excludes or stereotypes groups of students.

Choose one:

- `yes` Yes
- `no` No → Where

**DF1.** Are the difficulty and the amount of work appropriate for the target level and course phase?

_Judge against the brief, the size facts in the header, and the diff._

Choose one:

- `yes` Yes
- `no` No → Too easy or too little work / Too hard or too much work; Why

**SC1.** Does the template give the right amount of support, so that the student's effort goes to the target concept?

_Look for:_ students must write boilerplate the exercise does not aim to teach (visible in the diff); so much is given that little remains; stubs whose purpose is unclear.

Choose one:

- `yes` Yes
- `no` No → Where

**SC2.** Do the tasks of the statement form useful steps, so that students see their partial progress?

_Look for:_ one task for a multi-part exercise; a task that cannot be attempted before a later one; task titles that do not say what to do.

Choose one:

- `yes` Yes
- `no` No → Where

**OAB.** Other didactical issues in Parts A and B

Free text, optional.

### Part C: Test overview

_Open now: the test overview, which shows the test names and failure messages of each task as students see them in Artemis. It does not show test code._

**FB1.** Would a student who fails a test learn from its name and message what is wrong, without being handed the solution?

_Look for:_ tests without a message, so the student sees only "expected: <3> but was: <0>"; names such as `test1`; messages that spell out the code to write.

Choose one:

- `yes` Yes
- `no` No → Where

**RD1.** How much work would it take you to deploy this exercise to students at the target level?

Choose one:

- `5` Deploy as is: No change needed.
- `4` Minor edits: Wording or formatting only; code and tests stay unchanged.
- `3` Moderate edits: Local changes to the statement, the template, or a few tests; the design stays.
- `2` Major revision: Parts of the task, the template, or the test suite must be redesigned.
- `1` Discard: Writing the exercise from scratch would be faster.

### Part D: Automatic findings

_Open now: the automatic findings. Consider them only for the questions in this part._

**AF1.** Do the automatic findings reveal a material problem that you had not noticed in Parts A to C?

_The materiality rule applies._

Choose one:

- `yes` Yes → Which
- `no` No
- `na` N/A, no findings reported

**AF2.** Is every automatic finding correct and relevant for this exercise?

Choose one:

- `yes` Yes
- `no` No → Which finding and why
- `na` N/A, no findings reported

**RD2.** After seeing the automatic findings: how much work would it take you to deploy this exercise to students at the target level?

_Use the same scale as for RD1. You may choose the same level as in RD1._

Choose one:

- `5` Deploy as is: No change needed.
- `4` Minor edits: Wording or formatting only; code and tests stay unchanged.
- `3` Moderate edits: Local changes to the statement, the template, or a few tests; the design stays.
- `2` Major revision: Parts of the task, the template, or the test suite must be redesigned.
- `1` Discard: Writing the exercise from scratch would be faster.

**CHG.** The single most important change

Free text, required unless RD2 is 5.

**REM.** Remarks on earlier answers

Free text, optional. Anything that later material made you see differently.

## Final survey

Your answers refer to all exercises you rated.

**X1.** How confident are you in your ratings overall?

Choose one (1 = not confident, 5 = very confident):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**X2.** Was the material sufficient to judge the didactical quality?

Choose one:

- `yes` Yes
- `no` No → Missing material

**X3.** Were any questionnaire items unclear or hard to answer?

Choose one:

- `no` No
- `yes` Yes → Which items and why

**X4.** Compared with programming exercises you have written or used in your own teaching, the exercises you rated were overall:

Choose one (1 = much worse, 5 = much better):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5
- `cannot_judge` Cannot judge

**X5.** How useful were the automatic findings for your deployment decision?

Choose one (1 = not useful, 5 = very useful):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**X6.** Would you use such a generator to create exercises for your own course?

Choose one:

- `no` No
- `starting_point` Only as a starting point for my own exercise
- `with_review` Yes, with a review like the one in this study
- `little_review` Yes, with little review

**X7.** How demanding was this study for you?

Choose one (1 = very low, 5 = very high):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**X8.** Further comments

Free text, optional.
