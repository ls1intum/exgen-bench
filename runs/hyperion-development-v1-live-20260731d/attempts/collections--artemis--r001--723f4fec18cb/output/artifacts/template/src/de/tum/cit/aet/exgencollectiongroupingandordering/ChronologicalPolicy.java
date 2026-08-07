package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Orders purchases by increasing timestamp (oldest first).
 *
 * TODO: implement the ordering logic.
 */
public class ChronologicalPolicy implements PurchaseOrderingPolicy {
    /** Constructs a {@code ChronologicalPolicy}. */
    public ChronologicalPolicy() {
        // no state
    }

    @Override
    public int compare(Purchase a, Purchase b) {
        // TODO: implement comparison based on timestamp
        throw new UnsupportedOperationException("Not implemented");
    }
}
