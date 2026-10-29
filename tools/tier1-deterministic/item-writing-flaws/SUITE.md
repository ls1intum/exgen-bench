# item-writing-flaws development suite

Item-writing flaws that rules detect more reliably than a rater. Evaluation design v2 assigns them to
Tier 1, so neither the LLM judge nor the expert is asked about them.

## What it measures

| Metric                             | Type  | Counts                                                                                                                    |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `tests.assertions_without_message` | count | assertions in behavioural tests without a failure message; the score carries the assertion total as its denominator       |
| `flaws.exact_float_assertions`     | count | `assertEquals` or `assertNotEquals` on a floating-point literal without a delta                                           |
| `flaws.replayed_examples`          | count | behavioural tests whose calls with literal arguments all replay a worked example of the statement                         |
| `flaws.undefined_labels`           | count | step or rule labels (`S1`, `R7`) in a template `TODO` or at the start of a test message that the statement never mentions |

The evaluator has no acceptance gate. Every metric is exploratory: the detectors are lexical, and
evaluation design v2 checks their precision in the pilot, where the study team labels each finding as
a true or false positive. Their recall is unknown.

## Detectors

- **Assertion messages.** A JUnit 5 assertion carries a message when it has more arguments than its
  base form and the last one is a string expression or a message supplier, so
  `assertEquals(1.0, x, 1e-9)` counts as a delta, not a message. Structural tests are excluded;
  custom assertion helpers and `assertThat` chains are not counted.
- **Exact floating-point equality.** Only literal operands are recognised, with a decimal point, an
  exponent or a `d`/`f` suffix: `assertEquals(2.5, x)` is reported, `assertEquals(expected, x)` with
  a `double` variable is not.
- **Replayed examples.** Worked-example calls are taken from the statement's code spans and fenced
  blocks, need at least one literal argument, and must call a method the template or the solution
  declares, so `List.of(1, 2, 3)` showing an expected value is not an example. A test is reported
  when its literal-argument calls to those example methods are all calls the statement already
  shows, so a hard-coded answer passes it. Calls quoted in a comment or a string are not read.
- **Undefined labels.** A label is a capital letter or two followed by one or two digits, after
  `TODO` in a template comment, or at the start of a test string and followed by `:` or `-` and a
  space (`R7: ...`, so data such as `A1:B2` is not a label). It counts as defined when the
  statement mentions it anywhere.

## Status

Development suite. No model, no build, no reference.
