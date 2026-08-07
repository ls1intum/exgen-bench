package de.tum.cit.aet.exgenlibrarycheckoutrules;

/**
 * Aggregated overdue information for a single library member.
 *
 * @param overdueCount number of overdue checkout events for the member
 * @param fees         total fees for the member (overdue days * DAILY_FEE)
 */
public record MemberSummary(int overdueCount, double fees) {
}
