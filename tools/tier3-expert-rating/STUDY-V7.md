# Main expert study · Instrument 7

The [instrument](instruments/7.yaml) defines the wording and response rules used by the survey and
the staged Judge. It rates the twelve archived Java exercise drafts prepared for this study. Two
instructors review each draft independently. Each instructor reviews three drafts.

## What reviewers see

| Part | Material added                                      | Decisions                                                      |
| ---- | --------------------------------------------------- | -------------------------------------------------------------- |
| A    | Student problem statement and starter files         | Are the student instructions clear enough?                     |
| B    | Instructor prompt and sample solution changes       | Learning goal, workload, starter support                       |
| C    | Test names, outcomes and available failure messages | Explicit requirements, test feedback, first readiness decision |
| D    | Automatic findings and measurements                 | Fresh readiness decision, what the checks added                |

The starter tree opens on exercise files. Build and setup files remain available in their own group.
A setup file named in the student instructions stays in the main tree. The introduction includes one
short example that participants can reopen in A, C and D. The survey asks for a short location or
repair when an answer needs evidence. In D a participant can refer to their earlier repair after
selecting the new readiness rating.

Use `bun run survey:demo` to try the synthetic study. Its main and reserve links use instrument 7.
Its test links use instrument 6. The historical instruments and their closing questionnaires
remain available for existing pilot and test sessions. The study-team preview uses the main
instrument and shows each material view where it first opens.

## Why these questions

An explicit requirement can be met or violated. Workload can be too small, about right or too
large. Readiness distinguishes the work needed before assigning an exercise. Each question supplies
its own labels and separates insufficient evidence from an observed problem. The survey keeps
definitions visible and uses the example to clarify the distinction between editorial and
substantive repairs. [Item-specific responses](https://doi.org/10.18148/srm/2010.v4i1.2682) ·
[Visible question definitions](https://pubmed.ncbi.nlm.nih.gov/23411499/)

The exercise review keeps clarity, teaching fit and feedback separate from technical checks. A
passing test suite alone cannot establish teaching fit. A failed check needs inspection before it
establishes a grading fault. [Programming exercise evaluation](https://juholeinonen.com/assets/pdf/sarsa2022automatic.pdf) ·
[Expert and student evidence](https://juholeinonen.com/assets/pdf/logacheva2024evaluating.pdf)

## What the study measures

- Report the five readiness levels and both planned judgments per exercise, with pending,
  unassessable and split pairs visible. Retain the readiness categories 4–5 ready, 3 local repair,
  and 1–2 major revision or replacement. Two or three different judgments can remain unresolved.
- Report the transition from C to D and what each reviewer said the findings added. The sequence is
  fixed, so the study describes changes after the reveal. Audit the accuracy of individual claims
  from their evidence separately. A reproduced incorrect grade is a separate technical result.
- Compare the [staged Judge](../tier2-judge/llm-judge/STAGED-JUDGE.md) with each planned judgment.
  It uses the same items, rules, example and phased materials. Record abstentions, missing and
  unassessable evidence, and incorrect or unsupported judgments. Test the model on synthetic
  bundles and fix its configuration before inspecting main-study answers.
- Limit conclusions to these drafts and this course context. Record the actual archive selection and
  verification history. Some drafts may fail a technical check. The study cannot estimate model
  rankings or learning outcomes from these reviews.

## Before invitations

1. Verify the frozen exercise manifest, actual selection rule, versioned consent and planned pairs.
   Use new synthetic materials to check one short example, the meaning of **Prompt**, the setup
   disclosure, and the editorial-versus-local boundary with two eligible reviewers.
2. Rehearse all three exercises silently with one eligible reviewer. Check the longest and most
   defect-heavy cases, where the time goes, and whether the proposed invitation estimate is fair.
3. Verify a real staged Judge run on synthetic exercises, the complete participant flow, and separate
   pilot and main exports. Check the codebook, empty tests and findings, and readiness without a
   preselected answer. Run these checks and the human rehearsal on a separate synthetic or restored
   stack. Do not rehearse on a live main or reserve link. The previous pilot keeps its original
   instrument. Its separate export verifies that those responses survived activation.
4. Review both consent views against the V7 flow. Use the rehearsal to confirm the time estimate.
   The main consent summary and full information must both describe the three exercise reviews
   and the closing reflection. Use the cohort-specific overrides below.
5. Follow the [activation procedure](deploy/README.md) to verify and deploy instrument 7 before any
   main or reserve participant starts. Preserve pilot responses and assignments. Send invitations
   after reviewing the launch checks.

### Main-study consent

In `main_consent_summary`, replace the task description and time estimate with the text below.
Keep the approved wording on participation, storage and withdrawal.

> You’ll review three AI-generated exercises for an introductory Java course. For each one, tell
> us whether it’s ready to give to students and what you would change first. You’ll answer a few
> questions about your experience and reflect on the review at the end. Set aside about [time
> confirmed in rehearsal]. You can pause and return with your personal link.

Copy `consent.details` to `main_consent_details` and replace the **What you will do** paragraph
with the text below. Review the complete displayed text alongside the short summary before
approving the data change.

> **What you will do.** After a short introduction and questions about your experience, you’ll
> review three introductory Java exercises. You’ll read the student instructions and starter code,
> then look at the instructor’s prompt, sample solution changes, and test feedback. You’ll decide
> what you’d change before giving each exercise to students, then decide again after seeing the
> automatic findings. You’ll finish with a short reflection. A tour shows you how to use the review
> screen.
