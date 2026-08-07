package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Orders purchases by decreasing timestamp (newest first).
 *
 * TODO: implement the ordering logic.
 */
public class ReverseChronologicalPolicy implements PurchaseOrderingPolicy {
    /** Constructs a {@code ReverseChronologicalPolicy}. */
    public ReverseChronologicalPolicy() {
        // no state
    }

    @Override
    public int compare(Purchase a, Purchase b) {
        // TODO: implement comparison based on timestamp in reverse order
        throw new UnsupportedOperationException("Not implemented");
    }
}
