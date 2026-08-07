# Safety Band Classification

In this exercise we work with a single numeric reading and decide which safety band it belongs to. The band boundaries are fixed and given by two constants:

* **LOWER_BOUND** – the lowest value that is still considered *NORMAL*.
* **UPPER_BOUND** – the highest value that is still considered *NORMAL*.

Your task is to implement the `classify` method so that it returns exactly one of the three labels:

* `"BELOW"` – when the reading is **strictly less** than `LOWER_BOUND`.
* `"NORMAL"` – when the reading is **greater than or equal to** `LOWER_BOUND` **and** **less than or equal to** `UPPER_BOUND`.
* `"ABOVE"` – when the reading is **strictly greater** than `UPPER_BOUND`.

All inputs are guaranteed to be finite `double` values (no `NaN` or infinities).

## Public API

```java
package de.tum.cit.aet.exgencb680d7dc36c49b0;

public class SafetyBandClassifier {
    public static final double LOWER_BOUND = 0.0;
    public static final double UPPER_BOUND = 100.0;
    public SafetyBandClassifier() { /* default constructor */ }
    public String classify(double reading); // returns "BELOW", "NORMAL" or "ABOVE"
}
```

## Worked Examples

| Reading | Expected label |
|--------|----------------|
| -12.5  | "BELOW" |
| 0.0    | "NORMAL" (exact lower bound) |
| 45.7   | "NORMAL" |
| 100.0  | "NORMAL" (exact upper bound) |
| 123.4  | "ABOVE" |

## Tasks

[task][Implement the classification logic](<testid>178</testid>,<testid>175</testid>,<testid>179</testid>,<testid>176</testid>,<testid>177</testid>)

Implement the `classify` method of `SafetyBandClassifier` so that it returns the correct label for any finite reading according to the three rules described above.