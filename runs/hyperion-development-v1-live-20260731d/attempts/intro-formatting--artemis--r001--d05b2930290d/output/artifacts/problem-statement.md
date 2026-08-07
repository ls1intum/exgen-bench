# Human‑Readable Number Formatting

In this exercise we implement a tiny formatter that turns a numeric amount into a readable string consisting of a rounded value, a space, and a unit (e.g. a currency symbol). You will provide the rounding, sign handling and unit concatenation logic.

[task][Format amounts with rounding, sign handling and unit appending](<testid>26</testid>,<testid>23</testid>,<testid>24</testid>,<testid>22</testid>,<testid>27</testid>,<testid>25</testid>,<testid>28</testid>)
Implement the constructor `NumberFormatter(String unit)` and the method `String format(double amount)`.

## What the formatter must do

1. **Round to two decimal places** – use *half‑up* rounding (a third decimal digit of 5 or more rounds the second digit up, otherwise down).
2. **Sign handling**
   * If the rounded value is negative, the output starts with a leading `-`.
   * If the rounded value is exactly zero, the output contains **no sign**.
3. **Always show two decimal digits** – add trailing zeros when necessary (e.g. `5` → `5.00`).
4. **Append the unit** – the unit supplied when the formatter is created is appended after a single space.

The formatter works for any finite `double` value (positive, negative or zero). Non‑finite values (`NaN`, `Infinity`) are outside the scope of the exercise and are never used in the tests.

## Worked examples

| Input (amount, unit) | Result |
|----------------------|--------|
| `12.3456`, `"USD"` | `"12.35 USD"` |
| `-0.004`, `"EUR"`   | `"0.00 EUR"` |
| `-2.5`,   `"EUR"`   | `"-2.50 EUR"` |

## Public API

```java
package de.tum.cit.aet.exgendeterministicnumberformatting;

public class NumberFormatter {
    /**
     * Creates a formatter that will append the given unit to every formatted amount.
     *
     * @param unit the currency or measurement unit, e.g. "USD" or "kg"
     */
    public NumberFormatter(String unit) { /* stub */ }

    /**
     * Formats the supplied amount according to the rules described above.
     *
     * @param amount the raw numeric amount, may be positive, negative or zero
     * @return a human‑readable string consisting of the rounded number, a space, and the unit
     */
    public String format(double amount) { /* stub */ }
}
```

The class is the only type you need to implement.