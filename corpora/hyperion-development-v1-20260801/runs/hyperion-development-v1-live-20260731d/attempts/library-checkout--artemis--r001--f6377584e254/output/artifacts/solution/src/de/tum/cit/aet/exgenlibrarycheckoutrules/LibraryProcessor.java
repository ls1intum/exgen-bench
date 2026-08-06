package de.tum.cit.aet.exgenlibrarycheckoutrules;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

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
        if (events == null) {
            throw new IllegalArgumentException("events must not be null");
        }
        int totalOverdueCount = 0;
        double totalFees = 0.0;
        Map<String, MemberSummary> perMemberMutable = new HashMap<>();
        for (CheckoutEvent e : events) {
            if (e.daysOverdue() > 0) {
                totalOverdueCount++;
                double fee = e.daysOverdue() * DAILY_FEE;
                totalFees += fee;
                perMemberMutable.compute(e.memberId(), (id, old) -> {
                    if (old == null) {
                        return new MemberSummary(1, fee);
                    } else {
                        return new MemberSummary(old.overdueCount() + 1, old.fees() + fee);
                    }
                });
            }
        }
        // Ensure map is immutable in the record
        Map<String, MemberSummary> perMember = Map.copyOf(perMemberMutable);
        return new LibrarySummary(totalOverdueCount, totalFees, perMember);
    }
}
