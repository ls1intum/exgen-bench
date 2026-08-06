package de.tum.cit.aet.exgencollectiongroupingandordering;

/**
 * Immutable data holder representing a purchase made by a client at a specific timestamp.
 */
public class Purchase {
    private final String clientId;
    private final long timestamp;

    /**
     * Creates a new {@code Purchase}.
     *
     * @param clientId the identifier of the client, must be non‑null
     * @param timestamp the timestamp of the purchase
     */
    public Purchase(String clientId, long timestamp) {
        if (clientId == null) {
            throw new NullPointerException("clientId must not be null");
        }
        this.clientId = clientId;
        this.timestamp = timestamp;
    }

    /** Returns the client identifier. */
    public String getClientId() {
        return clientId;
    }

    /** Returns the timestamp of the purchase. */
    public long getTimestamp() {
        return timestamp;
    }
}
