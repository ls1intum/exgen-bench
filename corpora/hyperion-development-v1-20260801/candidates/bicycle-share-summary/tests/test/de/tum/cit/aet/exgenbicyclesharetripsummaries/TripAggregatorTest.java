package de.tum.cit.aet.exgenbicyclesharetripsummaries;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class TripAggregatorTest {

    @Test
    @StrictTimeout(1)
    void emptyList() {
        List<Trip> trips = Collections.emptyList();
        TripSummary summary = TripAggregator.summarize(trips);
        assertEquals(0, summary.getTotalDuration(), "total duration should be 0 for empty list");
        assertEquals(0, summary.getLongTripCount(), "long trip count should be 0 for empty list");
        assertTrue(summary.getDeparturesPerStation().isEmpty(), "departures map should be empty for empty list");
    }

    @Test
    @StrictTimeout(1)
    void onlyInvalidTrips() {
        List<Trip> trips = List.of(
                new Trip("A", 0),
                new Trip("B", -10),
                new Trip("C", -1)
        );
        TripSummary summary = TripAggregator.summarize(trips);
        assertEquals(0, summary.getTotalDuration());
        assertEquals(0, summary.getLongTripCount());
        assertTrue(summary.getDeparturesPerStation().isEmpty());
    }

    @Test
    @StrictTimeout(1)
    void mixedValidAndInvalidIncludingBoundary() {
        List<Trip> trips = List.of(
                new Trip("A", 10),   // valid, not long
                new Trip("B", 45),   // valid, long
                new Trip("A", -5),   // invalid
                new Trip("C", 30),   // valid, exactly 30 (not long)
                new Trip("B", 31)    // valid, long
        );
        TripSummary summary = TripAggregator.summarize(trips);
        assertEquals(10 + 45 + 30 + 31, summary.getTotalDuration());
        assertEquals(2, summary.getLongTripCount());
        Map<String, Integer> expectedMap = Map.of(
                "A", 1,
                "B", 2,
                "C", 1
        );
        assertEquals(expectedMap, summary.getDeparturesPerStation());
    }

    @Test
    @StrictTimeout(1)
    void duplicateStationsAggregation() {
        List<Trip> trips = List.of(
                new Trip("X", 5),
                new Trip("X", 15),
                new Trip("Y", 40),
                new Trip("X", 20),
                new Trip("Y", 25)
        );
        TripSummary summary = TripAggregator.summarize(trips);
        assertEquals(5 + 15 + 40 + 20 + 25, summary.getTotalDuration());
        assertEquals(1, summary.getLongTripCount()); // only 40 > 30
        Map<String, Integer> expected = new HashMap<>();
        expected.put("X", 3);
        expected.put("Y", 2);
        assertEquals(expected, summary.getDeparturesPerStation());
    }
}
