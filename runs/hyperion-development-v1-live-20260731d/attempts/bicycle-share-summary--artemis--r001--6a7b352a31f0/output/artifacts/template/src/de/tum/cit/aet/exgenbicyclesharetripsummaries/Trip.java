package de.tum.cit.aet.exgenbicyclesharetripsummaries;

/**
 * Immutable data holder representing a single bicycle‑share trip.
 * <p>
 * Each trip is identified by the station from which it departs and the duration in minutes.
 * The {@code stationId} must be non‑null and the {@code durationMinutes} may be any integer,
 * but only trips with a strictly positive duration are considered valid for aggregation.
 */
public class Trip {
    private final String stationId;
    private final int durationMinutes;

    /**
     * Creates a new {@code Trip}.
     *
     * @param stationId the identifier of the departure station; must be non‑null
     * @param durationMinutes the duration of the trip in minutes
     */
    public Trip(String stationId, int durationMinutes) {
        if (stationId == null) {
            throw new IllegalArgumentException("stationId must not be null");
        }
        this.stationId = stationId;
        this.durationMinutes = durationMinutes;
    }

    /** Returns the station identifier. */
    public String getStationId() {
        return stationId;
    }

    /** Returns the duration in minutes. */
    public int getDurationMinutes() {
        return durationMinutes;
    }
}
