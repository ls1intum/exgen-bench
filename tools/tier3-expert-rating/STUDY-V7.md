# Main expert study · Instrument 7

The [instrument](instruments/7.yaml) defines the wording and response rules used by the survey and
the staged Judge. It rates the twelve archived Java exercise drafts prepared for this study. Two
instructors review each draft independently. Each instructor reviews three drafts.

## What reviewers see

| Part | Material added                                      | Decisions                                                                  |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| A    | Student problem statement and starter files         | Are the student instructions clear enough?                                 |
| B    | Instructor prompt and sample solution changes       | Learning goal, workload, starter support                                   |
| C    | Test names, outcomes and available failure messages | Explicit requirements, test feedback, first readiness decision             |
| D    | Automatic findings and measurements                 | Second readiness decision, evidence of wrong grades, what the checks added |

The starter tree opens on exercise files. Build and setup files have their own group. A setup file
named in the student instructions stays in the main tree. Finding evidence appears beside its
finding. Measurements and unavailable checks have a separate disclosure.

On desktop, reviewers can scroll the questions separately while the progress, material tabs and
submit button stay visible. On narrow screens, reviewers switch between material and questions and
return to their previous reading position. The first exercise opens with a short tour. Reviewers can
skip it or replay it from the review screen. The elapsed time for a part includes the tour and
any pauses. The event export records when the tour opens and closes.

Separate, optional examples alongside both readiness questions illustrate editorial fixes, local
repairs and major revisions. Reviewers choose one level for the whole exercise. Most diagnostic answers
need a choice only. Short notes are required for a readiness repair, an explicit Prompt mismatch,
a claimed grading error, a finding that affected the decision, or unavailable material. In D the
reviewer chooses a readiness level first. They can then reopen the earlier readiness answer
and reuse the note while entering their decision. The grading question comes before FIND.

Use `bun run survey:demo` to try the synthetic study. Its main and reserve links use instrument 7.
Its test links use instrument 6. The historical instruments and their closing questionnaires
remain available for existing pilot and test sessions. The study-team preview uses the main
instrument and shows each material view where it first opens.

## Why these questions

An explicit requirement can be met or violated. Workload can be too small, about right or too
large. Readiness records the work needed before assigning an exercise. These questions use
answer choices that fit each decision. Making routine location notes optional reduces the extra
work attached to reporting a problem. [Item-specific response experiment](https://doi.org/10.18148/srm/2010.v4i1.2682) ·
[Follow-up burden](https://doi.org/10.1093/poq/nfu030)

The readiness examples illustrate the 4/3 and 3/2 boundaries. Each shows a separate case so the
reader can apply the scale to the whole exercise. Survey experiments show that examples can
influence what respondents consider and report. We keep the examples at the point of the readiness
decision. This keeps them out of the earlier parts on the first exercise. Reviewers may remember
them on later exercises. The pretest checks how instructors interpret these cases and apply the
scale to new ones.
[Survey example experiments](https://doi.org/10.1093/poq/nft083)

A test can help students diagnose a mistake and still assign credit incorrectly. GRADE asks whether
the material shows a concrete wrong-grade case, in either direction. Missing coverage, a passing
starter test and a failing sample solution are clues. A reviewer has to connect the task, solution
behaviour and grading outcome before reporting an error. In C the study only gives reviewers test
names, outcomes and messages. D adds check results. The two readiness decisions measure what reviewers would change before
and after seeing the report. GRADE is asked only after the reveal. [Programming exercise evaluation](https://doi.org/10.1145/3501385.3543957) ·
[Impact of test suites on grades](https://doi.org/10.1109/CSEET49119.2020.9206231) ·
[Study with student outcomes](https://doi.org/10.1145/3632620.3671103)

## What the study measures

- Report the five readiness levels and both planned judgments per exercise, with pending,
  unassessable and split pairs visible. Retain the readiness categories 4–5 at most editorial, 3 local repair,
  and 1–2 major revision or replacement. Two or three different judgments can remain unresolved.
- Report the C-to-D transition overall and by exercise position, with the recorded opening of
  earlier answers. FIND describes what the reviewer says the results contributed, including useful
  evidence for keeping a decision. Compare cited findings with the pre-reveal repair notes and
  the independent finding audit. The fixed sequence combines exposure to the findings with a
  second look, and repeated check types can prime later reviews.
- Report GRADE separately from feedback and readiness. A reported example is a lead for
  verification. A no-case response states the limits of the visible evidence. Keep independently
  reproduced grading errors as a separate result.
- Compare the [staged Judge](../tier2-judge/llm-judge/STAGED-JUDGE.md) with each planned judgment.
  It uses the same rubric and phased materials. Report missing answers, abstentions, disagreements
  about applicability, errors across the readiness cut-off and unsupported locators. The Judge
  starts a fresh D call, while humans remember what they read and rated in C. Use disagreements to
  audit what the Judge could catch or miss on these drafts. [Alternative Annotator Test](https://aclanthology.org/2025.acl-long.782/)
- Limit conclusions to these drafts and this course context. Record the actual archive selection and
  verification history. Some drafts may fail a technical check. The study cannot estimate model
  rankings or learning outcomes from these reviews.

## Before invitations

1. Verify the frozen exercise manifest, actual selection rule, versioned consent and planned pairs.
   Ask two eligible reviewers to explain **Prompt**, find a named setup file, and classify short
   synthetic cases at the editorial/local and local/major boundaries before showing the answer
   key. Include a case with more than one issue and ask how they chose a single exercise-level
   rating. Record their reasoning and revisit disagreement or unintended interpretations.
   [Cognitive interviewing methods](https://doi.org/10.1093/poq/nfm006)
2. Rehearse all three exercises silently with one eligible reviewer. Check the longest and most
   defect-heavy cases, where the time goes, and whether the proposed invitation estimate is fair.
3. Verify a real staged Judge run on synthetic exercises, the complete participant flow, and separate
   pilot and main exports. Check the codebook, empty tests and findings, and readiness without a
   preselected answer. Run these checks and the human rehearsal on a separate synthetic or restored
   stack. Do not rehearse on a live main or reserve link. The previous pilot keeps its original
   instrument. Its separate export verifies that those responses survived activation. Record the
   model snapshot, parameters and application commit before looking at main-study responses. Have
   two study authors independently classify the archived findings for correctness and likely
   student impact while blinded to the raters’ judgments. Preserve the original classifications
   and reconcile differences before comparing the audit with ratings.
4. Review the welcome screen and its linked study privacy notice together. Confirm the time
   estimate in the rehearsal and check whether the final protocol needs an ethics vote or an update
   to an existing approval. [TUM non-medical ethics guidance](https://www.tum.de/en/about-tum/organization/ethics-committee)
5. Pin the data repository’s validation and deployment workflows to the released application
   commit. Use the [activation procedure](deploy/README.md) to verify and deploy instrument 7
   before any main or reserve participant starts. Preserve pilot responses and assignments. Send
   invitations after reviewing the launch checks.

### Main-study consent

Use one short welcome page. Show the task, time, who is responsible, what the team records and uses,
and how to withdraw before the consent checkbox. The **Privacy notice** link leads directly to the
study privacy notice with the full information about data handling, retention and rights. This follows
the EDPB’s layered approach to the information required under Articles 12 and 13. [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/) · [EDPB transparency guidance](https://www.edpb.europa.eu/system/files/2023-09/wp260rev01_en.pdf)

Use `main_consent_summary` for the task and time:

> You’ll review three AI-generated exercises for an introductory Java course. You’ll decide what,
> if anything, needs fixing before students use them. Set aside about [time confirmed in
> rehearsal]. You can pause and return using your personal link.

Use `main_consent_details` for the essential participation information:

> Technical University of Munich uses your ratings to evaluate the exercises and see when the
> automatic checks help. The study team records your answers, drafts, timing, and what you open
> under a study ID. We report results in aggregate.
>
> Taking part is voluntary. You can stop at any time or contact the study team to withdraw consent
> and have your answers deleted.

Use the current participation statement from the study definition. In the privacy notice, include
portability where applicable to the information participants provide. Check both pages against the
actual deployment, access, retention and withdrawal arrangements before using them with participants.
