package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Orders purchases by increasing timestamp (oldest first).
 */
public class ChronologicalPolicy implements PurchaseOrderingPolicy {
    /** Constructs a {@code ChronologicalPolicy}. */
    public ChronologicalPolicy() {
        // no state
    }

    @Override
    public int compare(Purchase a, Purchase b) {
        return Long.compare(a.getTimestamp(), b.getTimestamp());
    }
}
