package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Strategy interface defining an ordering between two {@link Purchase} instances.
 */
public interface PurchaseOrderingPolicy {
    /**
     * Compares two purchases.
     *
     * @param a the first purchase, never {@code null}
     * @param b the second purchase, never {@code null}
     * @return a negative integer, zero, or a positive integer as {@code a} is less than, equal to,
     *         or greater than {@code b} according to this policy.
     */
    int compare(Purchase a, Purchase b);
}
