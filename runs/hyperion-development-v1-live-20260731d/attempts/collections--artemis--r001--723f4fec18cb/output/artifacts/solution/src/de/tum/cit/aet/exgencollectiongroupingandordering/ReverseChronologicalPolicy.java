package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Orders purchases by decreasing timestamp (newest first).
 */
public class ReverseChronologicalPolicy implements PurchaseOrderingPolicy {
    /** Constructs a {@code ReverseChronologicalPolicy}. */
    public ReverseChronologicalPolicy() {
        // no state
    }

    @Override
    public int compare(Purchase a, Purchase b) {
        return Long.compare(b.getTimestamp(), a.getTimestamp());
    }
}
