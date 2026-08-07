package de.tum.cit.aet.exgenbicyclesharetripsummaries;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Provides aggregation functionality for a list of {@link Trip}s.
 *
 * <p>The {@link #summarize(List)} method computes three statistics according to the
 * specification:
 * <ul>
 *   <li>Total duration of all valid trips (duration &gt; 0).</li>
 *   <li>Count of valid trips with duration &gt; 30 minutes.</li>
 *   <li>Map of station identifiers to the number of valid departures from each station.</li>
 * </ul>
 */
public class TripAggregator {

    private TripAggregator() {
        // utility class – prevent instantiation
    }

    /**
     * Computes the aggregate statistics for the given list of trips.
     *
     * @param trips a non‑null list of {@link Trip} objects; the list itself must not be {@code null}
     * @return a {@link TripSummary} containing the computed aggregates
     * @throws NullPointerException if {@code trips} is {@code null}
     */
    public static TripSummary summarize(List<Trip> trips) {
        Objects.requireNonNull(trips, "trips must not be null");
        int totalDuration = 0;
        int longTripCount = 0;
        Map<String, Integer> departures = new HashMap<>();
        for (Trip trip : trips) {
            int duration = trip.getDurationMinutes();
            if (duration <= 0) {
                continue; // invalid trip, ignore completely
            }
            totalDuration += duration;
            if (duration > 30) {
                longTripCount++;
            }
            String station = trip.getStationId();
            departures.merge(station, 1, Integer::sum);
        }
        return new TripSummary(totalDuration, longTripCount, departures);
    }
}
