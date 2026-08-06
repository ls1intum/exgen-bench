package de.tum.cit.aet.exgenbicyclesharetripsummaries;

import java.util.Collections;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable data holder that contains the aggregated results of a collection of {@link Trip}s.
 */
public class TripSummary {
    private final int totalDuration;
    private final int longTripCount;
    private final Map<String, Integer> departuresPerStation;

    /**
     * Creates a new {@code TripSummary}.
     *
     * @param totalDuration the sum of durations of all valid trips
     * @param longTripCount the number of valid trips longer than 30 minutes
     * @param departuresPerStation a map from station identifier to the number of valid trips departing from it;
     *        the map must not be {@code null} and will be stored unmodifiable
     */
    public TripSummary(int totalDuration, int longTripCount, Map<String, Integer> departuresPerStation) {
        this.totalDuration = totalDuration;
        this.longTripCount = longTripCount;
        this.departuresPerStation = Collections.unmodifiableMap(Objects.requireNonNull(departuresPerStation, "departuresPerStation must not be null"));
    }

    /** Returns the total duration of all valid trips. */
    public int getTotalDuration() {
        return totalDuration;
    }

    /** Returns the number of valid trips longer than 30 minutes. */
    public int getLongTripCount() {
        return longTripCount;
    }

    /** Returns an unmodifiable view of the departures‑per‑station map. */
    public Map<String, Integer> getDeparturesPerStation() {
        return departuresPerStation;
    }
}
