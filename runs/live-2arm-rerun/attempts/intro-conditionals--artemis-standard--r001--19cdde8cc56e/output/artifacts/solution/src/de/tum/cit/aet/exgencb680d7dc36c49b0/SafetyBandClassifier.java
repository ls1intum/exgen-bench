package de.tum.cit.aet.exgencb680d7dc36c49b0;

/**
 * Classifies a numeric reading into one of three safety bands: BELOW, NORMAL, or ABOVE.
 * <p>
 * The classification follows three explicit rules:
 * <ul>
 *   <li>If the reading is strictly less than {@link #LOWER_BOUND}, the result is "BELOW".</li>
 *   <li>If the reading is greater than or equal to {@link #LOWER_BOUND} and less than or equal to {@link #UPPER_BOUND},
 *       the result is "NORMAL".</li>
 *   <li>If the reading is strictly greater than {@link #UPPER_BOUND}, the result is "ABOVE".</li>
 * </ul>
 * All inputs are assumed to be finite {@code double} values (no {@code NaN} or infinities).
 */
public class SafetyBandClassifier {
    /** Lower bound of the normal safety band (inclusive). */
    public static final double LOWER_BOUND = 0.0;
    /** Upper bound of the normal safety band (inclusive). */
    public static final double UPPER_BOUND = 100.0;

    /**
     * Default constructor. No state is stored; the method operates solely on its argument.
     */
    public SafetyBandClassifier() {
        // No initialization required.
    }

    /**
     * Classifies the given reading according to the three safety bands.
     *
     * @param reading a finite double value to classify
     * @return "BELOW" if {@code reading < LOWER_BOUND},
     *         "NORMAL" if {@code LOWER_BOUND <= reading <= UPPER_BOUND},
     *         "ABOVE" if {@code reading > UPPER_BOUND}
     */
    public String classify(double reading) {
        if (reading < LOWER_BOUND) {
            return "BELOW";
        } else if (reading <= UPPER_BOUND) { // reading >= LOWER_BOUND is implied by previous branch
            return "NORMAL";
        } else {
            return "ABOVE";
        }
    }
}
