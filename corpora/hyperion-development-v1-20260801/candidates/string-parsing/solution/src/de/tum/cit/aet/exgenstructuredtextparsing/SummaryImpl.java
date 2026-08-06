package de.tum.cit.aet.exgenstructuredtextparsing;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.StringJoiner;

/**
 * Concrete implementation of {@link Summary}. It is constructed from an array of {@link Entry} objects.
 */
public class SummaryImpl implements Summary {
    private final Entry[] entries;
    private final List<String> keys; // immutable view
    private final String formatted; // cached formatted string

    /**
     * Creates a summary from the given entries.
     *
     * @param entries array of entries; may be {@code null} (treated as empty array)
     */
    public SummaryImpl(Entry[] entries) {
        if (entries == null) {
            this.entries = new Entry[0];
        } else {
            // defensive copy to guarantee immutability
            this.entries = entries.clone();
        }
        // build keys list
        List<String> keyList = new ArrayList<>(this.entries.length);
        for (Entry e : this.entries) {
            keyList.add(e.getKey());
        }
        this.keys = Collections.unmodifiableList(keyList);
        // build formatted string
        this.formatted = buildFormatted(this.entries);
    }

    private static String buildFormatted(Entry[] entries) {
        StringBuilder sb = new StringBuilder();
        sb.append("Count: ").append(entries.length);
        for (Entry e : entries) {
            sb.append('\n');
            sb.append(e.getKey()).append(" -> ").append(e.getValue());
        }
        return sb.toString();
    }

    @Override
    public int getEntryCount() {
        return entries.length;
    }

    @Override
    public List<String> getKeys() {
        return keys;
    }

    @Override
    public String getFormatted() {
        return formatted;
    }
}
