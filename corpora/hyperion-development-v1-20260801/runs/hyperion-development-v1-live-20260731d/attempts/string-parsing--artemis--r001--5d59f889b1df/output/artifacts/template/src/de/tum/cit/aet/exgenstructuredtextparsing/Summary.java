package de.tum.cit.aet.exgenstructuredtextparsing;

import java.util.List;

/**
 * Public view of a parsing result.
 */
public interface Summary {
    int getEntryCount();
    List<String> getKeys();
    String getFormatted();
}
