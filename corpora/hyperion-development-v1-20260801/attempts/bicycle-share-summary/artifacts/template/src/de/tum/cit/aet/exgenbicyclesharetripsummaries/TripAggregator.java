package de.tum.cit.aet.exgenbicyclesharetripsummaries;

import java.util.List;
import java.util.Objects;

/**
 * Provides aggregation functionality for a list of {@link Trip}s.
 *
 * <p>Students must implement the {@link #summarize(List)} method according to the specification.
 */
public class TripAggregator {

    private TripAggregator() {
        // utility class – prevent instantiation
    }

    /**
     * Computes the aggregate statistics for the given list of trips.
     *
     * @param trips a non‑null list of {@link Trip} objects
     * @return a {@link TripSummary} containing the computed aggregates
     */
    public static TripSummary summarize(List<Trip> trips) {
        // TODO S1: implement aggregation logic
        Objects.requireNonNull(trips, "trips must not be null");
        throw new UnsupportedOperationException("Not implemented");
    }
}
