package de.tum.cit.aet.exgenlibrarycheckoutrules;

/**
 * Immutable data holder representing a single library checkout event.
 *
 * @param memberId    identifier of the library member
 * @param daysOverdue number of days the item is overdue; may be zero or negative
 */
public record CheckoutEvent(String memberId, int daysOverdue) {
}
