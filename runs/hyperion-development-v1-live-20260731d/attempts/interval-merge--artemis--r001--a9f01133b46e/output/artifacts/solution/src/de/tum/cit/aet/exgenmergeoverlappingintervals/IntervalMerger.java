package de.tum.cit.aet.exgenmergeoverlappingintervals;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * Utility class that merges a collection of {@link Interval}s into the minimal set of
 * non‑overlapping, non‑touching intervals.
 */
public class IntervalMerger {

    /**
     * Merges the given list of intervals according to the rules defined in the
     * exercise specification.
     *
     * @param intervals a possibly {@code null} list containing {@link Interval}s or {@code null} elements
     * @return a new list containing the merged intervals, sorted by start
     * @throws IllegalArgumentException if {@code intervals} is {@code null}
     */
    public static List<Interval> merge(List<Interval> intervals) {
        if (intervals == null) {
            throw new IllegalArgumentException("interval list must not be null");
        }
        // Filter out null elements
        List<Interval> filtered = new ArrayList<>();
        for (Interval i : intervals) {
            if (i != null) {
                filtered.add(i);
            }
        }
        if (filtered.isEmpty()) {
            return Collections.emptyList();
        }
        // Sort by start ascending
        filtered.sort(Comparator.comparingInt(Interval::getStart));
        List<Interval> result = new ArrayList<>();
        Interval current = filtered.get(0);
        for (int idx = 1; idx < filtered.size(); idx++) {
            Interval next = filtered.get(idx);
            // Overlap or touch condition: a.start <= b.end && b.start <= a.end
            if (next.getStart() <= current.getEnd()) {
                // Merge: extend end to max
                int newEnd = Math.max(current.getEnd(), next.getEnd());
                current = new Interval(current.getStart(), newEnd);
            } else {
                result.add(current);
                current = next;
            }
        }
        result.add(current);
        return result;
    }
}
