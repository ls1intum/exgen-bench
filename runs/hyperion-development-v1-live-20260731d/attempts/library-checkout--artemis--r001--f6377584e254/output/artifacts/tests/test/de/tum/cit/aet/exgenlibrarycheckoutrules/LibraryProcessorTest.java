package de.tum.cit.aet.exgenlibrarycheckoutrules;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class LibraryProcessorTest {

    @Test
    @StrictTimeout(1)
    void testEmptyList() {
        List<CheckoutEvent> events = List.of();
        LibrarySummary summary = LibraryProcessor.summarize(events);
        assertEquals(0, summary.totalOverdueCount(), "total overdue count should be 0 for empty input");
        assertEquals(0.0, summary.totalFees(), "total fees should be 0.0 for empty input");
        assertTrue(summary.perMember().isEmpty(), "perMember map should be empty for empty input");
    }

    @Test
    @StrictTimeout(1)
    void testOnlyNonOverdue() {
        List<CheckoutEvent> events = List.of(
                new CheckoutEvent("Alice", 0),
                new CheckoutEvent("Bob", -3)
        );
        LibrarySummary summary = LibraryProcessor.summarize(events);
        assertEquals(0, summary.totalOverdueCount());
        assertEquals(0.0, summary.totalFees());
        assertTrue(summary.perMember().isEmpty(), "Members without overdue events must not appear in map");
    }

    @Test
    @StrictTimeout(1)
    void testMixedEvents() {
        List<CheckoutEvent> events = List.of(
                new CheckoutEvent("Alice", 3),
                new CheckoutEvent("Bob", 0),
                new CheckoutEvent("Alice", -2),
                new CheckoutEvent("Bob", 5)
        );
        LibrarySummary summary = LibraryProcessor.summarize(events);
        assertEquals(2, summary.totalOverdueCount(), "Two overdue events expected");
        assertEquals(8.0, summary.totalFees(), "Fees should be 3*1 + 5*1 = 8.0");
        Map<String, MemberSummary> map = summary.perMember();
        assertEquals(2, map.size(), "Map should contain two members with overdue events");
        MemberSummary alice = map.get("Alice");
        assertNotNull(alice);
        assertEquals(1, alice.overdueCount());
        assertEquals(3.0, alice.fees());
        MemberSummary bob = map.get("Bob");
        assertNotNull(bob);
        assertEquals(1, bob.overdueCount());
        assertEquals(5.0, bob.fees());
    }

    @Test
    @StrictTimeout(1)
    void testMultipleEventsSameMember() {
        List<CheckoutEvent> events = List.of(
                new CheckoutEvent("Charlie", 2),
                new CheckoutEvent("Charlie", 4),
                new CheckoutEvent("Charlie", -1),
                new CheckoutEvent("Dana", 3)
        );
        LibrarySummary summary = LibraryProcessor.summarize(events);
        assertEquals(3, summary.totalOverdueCount());
        assertEquals(9.0, summary.totalFees()); // 2+4+3 = 9
        Map<String, MemberSummary> map = summary.perMember();
        assertEquals(2, map.size());
        MemberSummary charlie = map.get("Charlie");
        assertNotNull(charlie);
        assertEquals(2, charlie.overdueCount());
        assertEquals(6.0, charlie.fees()); // 2+4
        MemberSummary dana = map.get("Dana");
        assertNotNull(dana);
        assertEquals(1, dana.overdueCount());
        assertEquals(3.0, dana.fees());
    }
}
