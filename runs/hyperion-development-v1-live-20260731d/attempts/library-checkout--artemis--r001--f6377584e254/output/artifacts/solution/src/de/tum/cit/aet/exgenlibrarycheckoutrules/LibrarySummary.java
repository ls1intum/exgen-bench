package de.tum.cit.aet.exgenlibrarycheckoutrules;

import java.util.Map;
import java.util.Objects;

/**
 * Immutable aggregation result for a batch of {@link CheckoutEvent}s.
 *
 * @param totalOverdueCount total number of overdue events in the batch
 * @param totalFees         total fees for all overdue events (daysOverdue * DAILY_FEE)
 * @param perMember         map from member identifier to {@link MemberSummary}. The map contains
 *                          only members that have at least one overdue event.
 */
public record LibrarySummary(int totalOverdueCount, double totalFees,
                             Map<String, MemberSummary> perMember) {
    public LibrarySummary {
        // Defensive copy to guarantee immutability of the public record component
        perMember = Map.copyOf(Objects.requireNonNull(perMember));
    }
}
