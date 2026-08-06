package de.tum.cit.aet.exgenstructuredtextparsing;

/**
 * Immutable holder for a key/value pair parsed from structured text.
 */
public class Entry {
    private final String key;
    private final String value;

    public Entry(String key, String value) {
        if (key == null) {
            throw new IllegalArgumentException("key must not be null");
        }
        this.key = key;
        this.value = value == null ? "" : value;
    }

    public String getKey() {
        return key;
    }

    public String getValue() {
        return value;
    }
}
