# Expert study on generated programming exercises: instrument

Version 4. Generated from [`instrument.yaml`](instrument.yaml) by `bun run survey:instrument`; edit the YAML, not this file.

A rater first gives consent, in the wording of the study's `study.yaml`, and then sees the sections below in this order. The four parts of the rating repeat for every exercise assigned to the rater.

## Materiality rule

> Answer **No** if the problem would plausibly cost an introductory programming student noticeable time, lead to a wrong submission, or send them to a tutor. If the issue is cosmetic and does none of these, answer **Yes**.

## Introduction

### Purpose of the study

Thank you for taking part. We study how well an AI pipeline generates programming exercises
for introductory programming courses.

Each exercise starts from a **brief** that an instructor wrote: the learning objective, what
the students already know and what they have not learned yet, and the expected effort. From
the brief, the pipeline generated a complete exercise: a problem statement, a template that
students start from, a sample solution, and tests. The tests automatically assess students’ submissions (autograding). Every exercise you see has been checked
automatically: it compiles, its sample solution passes all its tests, and its template passes
none of them. We ask you to judge whether the exercise is suitable for teaching.

Neither you nor the other raters know which model the AI pipeline used for an exercise. Please do not
discuss the exercises with anyone until we tell you that the study has closed.

### How a rating works

You rate each exercise in four parts, about 18 minutes per exercise. Each part
adds material, and earlier material stays open:

| Part | You see                                                   | You rate                                            |
| ---- | --------------------------------------------------------- | --------------------------------------------------- |
| A    | The problem statement and the brief it was generated from | Clarity                                             |
| B    | + the template and the solution changes                   | Solvability, fit with the brief, scope, scaffolding |
| C    | + the tests and their failure messages                    | Feedback, readiness                                 |
| D    | + the automatic findings                                  | Automatic findings, readiness again                 |

You cannot go back to an earlier part. If later material changes your view, note it under
_Remarks on earlier answers_ in Part D. On your first exercise, a short tour shows you where
everything is.

### Answering the questions

You answer most questions with Yes or No; a few also offer N/A. When your answer points to a
problem, a short field asks where it is or why. For borderline cases, the materiality rule
applies:

> Answer **No** if the problem would plausibly cost an introductory programming student noticeable time, lead to a wrong submission, or send them to a tutor. If the issue is cosmetic and does none of these, answer **Yes**.

| Situation                                                                                                                                          | Question | Answer | Reason                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------- |
| "recieve" is misspelled in the problem statement                                                                                                   | CL2      | Yes    | A cosmetic issue                      |
| The problem statement and the template ask for the average but do not say how to round it, and the sample solution rounds it to two decimal places | SO1      | No     | Leads to a wrong submission           |
| The problem statement says "ignore invalid entries" without saying whether an empty name is invalid                                                | CL1      | No     | Two reasonable readings               |
| The test `countsOnlyActiveMembers` fails with "expected: <3> but was: <0>"                                                                         | FB1      | Yes    | The test name explains the problem    |
| Several tests are named `test1` to `test5` and have no messages                                                                                    | FB1      | No     | The student cannot tell what is wrong |

### Meaning of the readiness levels

Twice per exercise, you rate how much work you would need before you could use it in an
introductory programming course. These examples serve as anchors:

| Level              | Meaning                           | Typical example                                                                                  |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| 5 · Use as is      | No change needed                  | You would give the exercise to your students today.                                              |
| 4 · Minor edits    | Wording or formatting only        | You clarify a sentence or add the expected output format to the problem statement.               |
| 3 · Moderate edits | Local changes; the design stays   | You add failure messages to a few tests, rename a misleading stub, or fix one rule and its test. |
| 2 · Major revision | Parts must be redesigned          | The template already solves the core concept, or half of the tasks have no tests.                |
| 1 · Discard        | Writing it from scratch is faster | The exercise targets a different topic or level.                                                 |

Rate your own effort as an instructor; the other questions cover the effort of students.

## About you

Before the exercises, a few questions about your background. We use them to describe the group of raters and to interpret differences between ratings.

**B1.** Your current role

Choose one:

- `professor` Professor or lecturer
- `postdoc` Postdoc
- `phd` PhD student or teaching assistant
- `tutor` Student tutor
- `other` Other → Your role

**B2.** Years of experience in teaching or tutoring programming at a university

Choose one:

- `under_1` Less than 1
- `1_to_2` 1 to 2
- `3_to_5` 3 to 5
- `6_to_10` 6 to 10
- `over_10` More than 10

**B3.** Programming courses you have taught or tutored

Tick all that apply:

- `introductory` Introductory programming (first year)
- `advanced` Advanced programming, or algorithms and data structures
- `software_engineering` Software engineering
- `none` None so far (excludes the other options)
- `other` Other → Which course

**B4.** Programming exercises you have created or substantially revised

Choose one:

- `none` None
- `1_to_5` 1 to 5
- `6_to_20` 6 to 20
- `over_20` More than 20

**B5.** Have exercises you created or revised been assessed automatically, for example by unit tests that check each submission?

Choose one:

- `yes` Yes
- `no` No

**B6.** Your experience with Java, the language of the exercises

Choose one:

- `none` None: I have not written Java.
- `basic` Basic: I can read and write small programs.
- `advanced` Advanced: I write larger programs and use the standard library confidently.
- `professional` Professional: I use Java in my daily work.

**B7.** How often do you use AI tools to create teaching material?

Choose one:

- `never` Never
- `tried` Tried once or twice
- `occasionally` Occasionally
- `regularly` Regularly

**B8.** How much do you agree with this statement? “AI-generated exercises can, in principle, be suitable for teaching.”

Choose one (1 = strongly disagree, 5 = strongly agree):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

## Rating

Answer as an instructor who decides whether to give this exercise to the students of an introductory programming course.

### Part A: Problem statement

About 5 minutes. _Read the problem statement and the brief it was generated from._

**CL1.** Is every required behaviour stated so that only one reasonable reading exists?

_Look for:_ a rule two competent students would implement differently ("sort the items" without key or direction, an inclusive or exclusive bound); an example whose result does not follow from the stated rule.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task or a sentence is enough._

**CL2.** Is the problem statement easy to understand for an introductory programming student?

_Look for:_ undefined jargon; requirements buried in the narrative; a problem statement much longer or denser than the exercise warrants.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task or a sentence is enough._

### Part B: Template and solution changes

About 7 minutes. _Skim the template students start from: which files they get, which stubs they complete, and what the comments say. The solution changes show what students add or change; you do not need to check them line by line._

**SO1.** Do the problem statement and the template tell students everything they need to produce the expected results, without seeing the tests?

_Look for:_ an edge case mentioned without its expected result; an output that must match exactly (message text, number format, ordering) but is not given verbatim.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._

**OA1.** Does the exercise practise the concept or learning objective named in the brief?

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._

**OA2.** Must students actually apply the target concept to solve the exercise?

_Look for:_ the concept is already implemented in the template; a plain approach solves the exercise equally well and the problem statement does not rule it out (a recursion exercise solvable with a simple loop).

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._
- `na` N/A, the brief names no specific concept

**OA3.** Does the exercise honour the explicit requirements of the brief?

_Look for:_ a requested diagram, edge case, determinism constraint, given type, or prerequisite that the exercise ignores or exceeds.

Choose one:

- `yes` Yes
- `no` No → Unmet requirement

**OA4.** Is the scenario sensible and motivating for the exercise?

_Look for:_ a context bolted onto an unrelated computation; contrived rules presented as realistic; wrong domain facts; a scenario that excludes or stereotypes groups of students.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._

**DF1.** Is the scope right: enough work to practise the concept, and at most 60 minutes for a student at this point in the course?

_Judge from the brief and the solution changes._

Choose one:

- `yes` Yes
- `no` No → Too little to practise the concept / More than 60 minutes of work; Details (optional)

**SC1.** Does the template give the right amount of support, so that the students' effort goes to the target concept?

_Look for:_ students must write boilerplate the exercise does not aim to teach (visible in the solution changes); so much is given that little remains; stubs whose purpose is unclear.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._

**SC2.** Do the tasks of the problem statement form useful steps, so that students see their partial progress?

_Look for:_ one task for a multi-part exercise; a task that cannot be attempted before a later one; task titles that do not say what to do.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A task, a sentence, or a file is enough._

**OAB.** Other pedagogical issues in Parts A and B

Free text, optional.

### Part C: Tests

About 3 minutes. _Read each task's tests and the message a student sees when one fails. Where possible, the message comes from a wrong variant of the sample solution, as a student's mistake would produce it; otherwise it is the message on the template. Test code is not shown._

**FB1.** Would a student who fails a test learn from its name and message what is wrong, without being handed the solution?

_Look for:_ a test whose name and message together do not say what is wrong (`test1` failing with only "expected: <3> but was: <0>"); messages that spell out the code to write.

Choose one:

- `yes` Yes
- `no` No → Where, hint: _A test name is enough._

**RD1.** How much work would it take you before you could use this exercise in an introductory programming course?

Choose one:

- `5` Use as is: No change needed.
- `4` Minor edits: Wording or formatting only; code and tests stay unchanged.
- `3` Moderate edits: Local changes to the problem statement, the template, or a few tests; the design stays.
- `2` Major revision: Parts of the problem statement, the template, or the tests must be redesigned.
- `1` Discard: Writing the exercise from scratch would be faster.

### Part D: Automatic findings

About 3 minutes. _Read the automatic findings about this exercise. Answer this part's questions with them in mind; if they change your view of an earlier answer, note it under *Remarks on earlier answers*._

**AF1.** Do the automatic findings reveal a material problem that you had not noticed in Parts A to C?

_Count a problem only if it is material by the materiality rule._

Choose one:

- `yes` Yes → Which
- `no` No
- `na` N/A, the Findings tab lists no findings

**AF2.** Is every automatic finding correct and relevant for this exercise?

Choose one:

- `yes` Yes
- `no` No → Which finding and why
- `na` N/A, the Findings tab lists no findings

**RD2.** After reading the automatic findings: how much work would it take you before you could use this exercise in an introductory programming course?

_The same scale as in Part C; you may choose the same level again._

Choose one:

- `5` Use as is: No change needed.
- `4` Minor edits: Wording or formatting only; code and tests stay unchanged.
- `3` Moderate edits: Local changes to the problem statement, the template, or a few tests; the design stays.
- `2` Major revision: Parts of the problem statement, the template, or the tests must be redesigned.
- `1` Discard: Writing the exercise from scratch would be faster.

**CHG.** The single most important change you would make to this exercise

Free text, required unless RD2 is 5. Optional if you chose 5 · Use as is.

**REM.** Remarks on earlier answers

Free text, optional. Anything that later material made you see differently.

## Looking back

About 4 minutes. You have rated all your exercises. These questions look back on all of them; a short page on the briefs follows.

**X1.** How confident are you in your ratings overall?

Choose one (1 = not confident, 5 = very confident):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**X2.** Was the material enough to judge the exercises' pedagogical quality?

Choose one:

- `yes` Yes
- `no` No → Missing material

**X3.** Were any questions unclear or hard to answer?

Choose one:

- `no` No
- `yes` Yes → Which questions and why

**X4.** Compared with the programming exercises you have written or used in your own teaching, the exercises you rated were overall:

Choose one (1 = much worse, 5 = much better):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5
- `cannot_judge` Cannot judge

**X5.** How useful were the automatic findings for deciding whether to use an exercise?

Choose one (1 = not useful, 5 = very useful):

- `1` 1
- `2` 2
- `3` 3
- `4` 4
- `5` 5

**X6.** Would you use such an AI pipeline to create exercises for your own course?

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

## The briefs

About 10 minutes. These are the briefs for the exercises you rated, with matching numbers. Please review them and tell us whether they specify suitable exercises for an introductory programming course. Your comments help us improve the briefs.

_The page lists only the briefs of the rater’s assigned exercises, numbered to match their rating order._

**BR1.** Are the briefs clear and specific enough that an instructor would get the exercise they have in mind?

Choose one:

- `yes` Yes
- `no` No → Which briefs and why

**BR2.** Do the topics and stated prerequisites fit an introductory programming course?

Choose one:

- `yes` Yes
- `no` No → What does not fit

**BR3.** Comments on individual briefs

Free text, optional. Name the brief, such as “Brief 3”.
