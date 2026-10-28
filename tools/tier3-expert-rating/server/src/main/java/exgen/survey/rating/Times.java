package exgen.survey.rating;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/** Timestamps as the study exports them: UTC, to the millisecond, such as 2026-11-02T09:00:00.000Z. */
public final class Times {
    private static final DateTimeFormatter ISO =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private Times() {}

    public static String iso(Instant instant) {
        return instant == null ? null : ISO.format(instant);
    }
}
