package de.tum.cit.aet.exgencollectiongroupingandordering;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.PathType;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;
import static de.tum.in.test.api.util.ReflectionTestUtils.*;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class PurchaseGrouperBehaviorTest {

    private Purchase p(String client, long ts) {
        return new Purchase(client, ts);
    }

    private void assertPurchaseListEquals(List<Purchase> expected, List<Purchase> actual) {
        assertEquals(expected.size(), actual.size(), "List sizes differ");
        for (int i = 0; i < expected.size(); i++) {
            Purchase exp = expected.get(i);
            Purchase act = actual.get(i);
            assertEquals(exp.getClientId(), act.getClientId(), "ClientId differs at index " + i);
            assertEquals(exp.getTimestamp(), act.getTimestamp(), "Timestamp differs at index " + i);
        }
    }

    private void assertPurchaseListEquals(List<Purchase> expected, List<Purchase> actual, String message) {
        try {
            assertPurchaseListEquals(expected, actual);
        } catch (AssertionError e) {
            fail(message + ": " + e.getMessage());
        }
    }

    @Test
    @StrictTimeout(1)
    void testSingleClientMultiplePurchases() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 3000L),
                p("Alice", 1000L),
                p("Alice", 2000L)
        );
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Object policy = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.ChronologicalPolicy");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, policy);
        assertEquals(1, result.size(), "Map should contain one client key");
        List<Purchase> alice = result.get("Alice");
        assertNotNull(alice);
        assertPurchaseListEquals(List.of(p("Alice", 1000L), p("Alice", 2000L), p("Alice", 3000L)), alice, "Alice's purchases should be ordered chronologically");
    }

    @Test
    @StrictTimeout(1)
    void testGroupingAndChronologicalOrder() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 1000L),
                p("Bob", 1500L),
                p("Alice", 2000L),
                p("Bob", 1200L)
        );
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Object policy = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.ChronologicalPolicy");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, policy);
        assertEquals(2, result.size(), "Map should contain two client keys");
        List<Purchase> alice = result.get("Alice");
        assertNotNull(alice);
        assertPurchaseListEquals(List.of(p("Alice", 1000L), p("Alice", 2000L)), alice, "Alice's purchases should be ordered chronologically");
        List<Purchase> bob = result.get("Bob");
        assertNotNull(bob);
        assertPurchaseListEquals(List.of(p("Bob", 1200L), p("Bob", 1500L)), bob, "Bob's purchases should be ordered chronologically");
    }

    @Test
    @StrictTimeout(1)
    void testChronologicalOrdering() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 2000L),
                p("Alice", 1000L),
                p("Alice", 3000L)
        );
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Object policy = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.ChronologicalPolicy");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, policy);
        List<Purchase> alice = result.get("Alice");
        assertPurchaseListEquals(List.of(p("Alice", 1000L), p("Alice", 2000L), p("Alice", 3000L)), alice);
    }

    @Test
    @StrictTimeout(1)
    void testReverseChronologicalOrder() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 1000L),
                p("Bob", 1500L),
                p("Alice", 2000L),
                p("Bob", 1200L)
        );
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Object policy = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.ReverseChronologicalPolicy");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, policy);
        List<Purchase> alice = result.get("Alice");
        assertPurchaseListEquals(List.of(p("Alice", 2000L), p("Alice", 1000L)), alice);
        List<Purchase> bob = result.get("Bob");
        assertPurchaseListEquals(List.of(p("Bob", 1500L), p("Bob", 1200L)), bob);
    }

    @Test
    @StrictTimeout(1)
    void testEmptyInput() throws Exception {
        List<Purchase> purchases = Collections.emptyList();
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Object policy = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.ChronologicalPolicy");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, policy);
        assertTrue(result.isEmpty(), "Result map should be empty for empty input");
    }

    @Test
    @StrictTimeout(1)
    void testStableOrderWhenEqualTimestamps() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 1000L),
                p("Alice", 1000L),
                p("Alice", 2000L)
        );
        // Policy that treats all timestamps as equal
        PurchaseOrderingPolicy equalPolicy = new PurchaseOrderingPolicy() {
            @Override
            public int compare(Purchase a, Purchase b) {
                return 0;
            }
        };
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, equalPolicy);
        List<Purchase> alice = result.get("Alice");
        // Expect original insertion order preserved because compare returns 0
        assertEquals(purchases, alice, "When timestamps are equal, original order should be preserved (stable sort)");
    }
    
    @Test
    @StrictTimeout(1)
    void testStableOrderWhenEqualTimestampsHidden() throws Exception {
        List<Purchase> purchases = List.of(
                p("Alice", 1000L),
                p("Alice", 1000L),
                p("Alice", 2000L)
        );
        PurchaseOrderingPolicy equalPolicy = new PurchaseOrderingPolicy() {
            @Override
            public int compare(Purchase a, Purchase b) {
                return 0;
            }
        };
        Object grouper = newInstance("de.tum.cit.aet.exgencollectiongroupingandordering.PurchaseGrouper");
        Method method = getMethod(grouper, "groupByClient", List.class, PurchaseOrderingPolicy.class);
        @SuppressWarnings("unchecked")
        Map<String, List<Purchase>> result = (Map<String, List<Purchase>>) invokeMethod(grouper, method, purchases, equalPolicy);
        List<Purchase> alice = result.get("Alice");
        assertEquals(purchases, alice, "When timestamps are equal, original order should be preserved (stable sort)");
    }
}
