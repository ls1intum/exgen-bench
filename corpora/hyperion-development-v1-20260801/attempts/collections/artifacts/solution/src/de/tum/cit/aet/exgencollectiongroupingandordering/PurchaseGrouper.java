package de.tum.cit.aet.exgencollectiongroupingandordering;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Groups a list of {@link Purchase} objects by their client identifier and sorts each group according to a
 * supplied {@link PurchaseOrderingPolicy}.
 */
public class PurchaseGrouper {
    /** Constructs a {@code PurchaseGrouper}. */
    public PurchaseGrouper() {
        // no state
    }

    /**
     * Groups purchases by client and sorts each client's list.
     *
     * @param purchases the list of purchases to group, must not be {@code null} and contain no {@code null} elements
     * @param ordering  the ordering policy to apply to each client's list, must not be {@code null}
     * @return a map from client identifier to a list of purchases belonging to that client, ordered according to the policy
     * @throws NullPointerException if {@code purchases} or {@code ordering} is {@code null}
     */
    public Map<String, List<Purchase>> groupByClient(List<Purchase> purchases, PurchaseOrderingPolicy ordering) {
        Objects.requireNonNull(purchases, "purchases must not be null");
        Objects.requireNonNull(ordering, "ordering must not be null");
        // Ensure no null elements
        for (Purchase p : purchases) {
            Objects.requireNonNull(p, "purchase element must not be null");
        }
        Map<String, List<Purchase>> result = new HashMap<>();
        for (Purchase p : purchases) {
            result.computeIfAbsent(p.getClientId(), k -> new ArrayList<>()).add(p);
        }
        Comparator<Purchase> comparator = (a, b) -> ordering.compare(a, b);
        for (List<Purchase> list : result.values()) {
            // Collections.sort is stable; using List.sort also stable in Java 8+
            list.sort(comparator);
        }
        return result;
    }
}
