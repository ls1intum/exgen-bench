package de.tum.cit.aet.exgenmergeoverlappingintervals;

/**
 * Immutable value object representing a half‑open interval [start, end).
 * The interval includes {@code start} and excludes {@code end}.
 *
 * <p>Instances are created via the public constructor which validates that
 * {@code start < end}. The class provides accessor methods for the bounds.
 */
public class Interval {
    private final int start;
    private final int end;

    /**
     * Creates a new {@code Interval}.
     *
     * @param start the inclusive lower bound
     * @param end   the exclusive upper bound; must be greater than {@code start}
     * @throws IllegalArgumentException if {@code start >= end}
     */
    public Interval(int start, int end) {
        if (start >= end) {
            throw new IllegalArgumentException("start must be less than end");
        }
        this.start = start;
        this.end = end;
    }

    /** Returns the inclusive lower bound of the interval. */
    public int getStart() {
        return start;
    }

    /** Returns the exclusive upper bound of the interval. */
    public int getEnd() {
        return end;
    }
}
