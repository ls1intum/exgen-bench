package de.tum.cit.aet.exgenlibrarycheckoutrules;

import java.util.List;

/**
 * Provides functionality to compute a {@link LibrarySummary} from a list of {@link CheckoutEvent}s.
 */
public class LibraryProcessor {
    /**
     * Constant fee per overdue day.
     */
    private static final double DAILY_FEE = 1.0;

    /**
     * Computes a {@link LibrarySummary} for the given list of checkout events.
     *
     * @param events a list of {@link CheckoutEvent}; may be empty but must not be {@code null}
     * @return a {@link LibrarySummary} fulfilling the business rules R1‑R6
     */
    public static LibrarySummary summarize(List<CheckoutEvent> events) {
        // TODO S1: student implementation
        throw new UnsupportedOperationException("Not implemented");
    }
}
