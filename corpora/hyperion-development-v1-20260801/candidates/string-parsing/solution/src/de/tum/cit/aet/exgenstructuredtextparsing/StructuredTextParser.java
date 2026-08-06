package de.tum.cit.aet.exgenstructuredtextparsing;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Parses a simple key=value structured text format into a {@link Summary}.
 */
public class StructuredTextParser {

    /**
     * Parses the given text according to the rules defined in the exercise specification.
     *
     * @param text input text; {@code null} is treated as an empty string
     * @return a {@link Summary} representing the parsed entries
     */
    public static Summary parse(String text) {
        if (text == null) {
            text = "";
        }
        String[] lines = text.split("\n", -1); // keep trailing empty lines
        List<Entry> entryList = new ArrayList<>();
        for (String line : lines) {
            int idx = line.indexOf('=');
            if (idx < 0) {
                continue; // no '='
            }
            String rawKey = line.substring(0, idx).trim();
            if (rawKey.isEmpty()) {
                continue; // empty key after trimming
            }
            String rawValue = line.substring(idx + 1).trim();
            entryList.add(new Entry(rawKey, rawValue));
        }
        Entry[] entries = entryList.toArray(new Entry[0]);
        return new SummaryImpl(entries);
    }
}
