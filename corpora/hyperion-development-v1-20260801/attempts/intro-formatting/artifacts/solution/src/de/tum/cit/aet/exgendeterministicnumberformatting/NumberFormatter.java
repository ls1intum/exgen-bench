package de.tum.cit.aet.exgendeterministicnumberformatting;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Locale;

/**
 * Formats numeric amounts into a human‑readable string consisting of a rounded number,
 * a single space and a unit.
 *
 * <p>The rounding follows the rules defined in the exercise specification:
 * <ul>
 *   <li>Round the absolute value to exactly two decimal places using half‑up rounding.</li>
 *   <li>Include a leading minus sign only if the rounded amount is negative.</li>
 *   <li>For a rounded amount of zero, no sign is emitted.</li>
 *   <li>The numeric part always contains two decimal digits.</li>
 *   <li>The supplied unit is appended after a single space.</li>
 * </ul>
 */
public class NumberFormatter {
    private final String unit;

    /**
     * Creates a formatter that will append the given unit to every formatted amount.
     *
     * @param unit the currency or measurement unit, e.g. "USD" or "kg"
     */
    public NumberFormatter(String unit) {
        this.unit = unit;
    }

    /**
     * Formats the supplied amount according to Rules R1‑R5.
     *
     * @param amount the raw numeric amount, may be positive, negative or zero
     * @return a human‑readable string consisting of the rounded number, a space, and the unit
     */
    public String format(double amount) {
        // Round using half‑up to two decimal places.
        BigDecimal rounded = BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP);
        double roundedVal = rounded.doubleValue();

        // Determine sign handling.
        String sign = "";
        if (roundedVal == 0.0) {
            // No sign for zero (covers -0.0 as well).
            sign = "";
        } else if (roundedVal < 0) {
            sign = "-";
        }

        // Absolute value for the numeric part.
        double absVal = Math.abs(roundedVal);
        // Ensure exactly two decimal digits, using US locale to guarantee '.' as decimal separator.
        String number = String.format(Locale.US, "%.2f", absVal);

        return sign + number + " " + unit;
    }
}
