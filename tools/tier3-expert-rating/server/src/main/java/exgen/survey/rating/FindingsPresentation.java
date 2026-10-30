package exgen.survey.rating;

import org.springframework.http.HttpStatus;

/** Identifies observed browser presentations, separately from the frozen instrument and exercise. */
public final class FindingsPresentation {
    public static final String HEADER = "X-Survey-Presentation";
    public static final String LEGACY = "legacy-unversioned";
    public static final String CATEGORIES = "categories-v1";

    private FindingsPresentation() {}

    public static String fromHeader(String value) {
        if (value == null) return LEGACY;
        if (CATEGORIES.equals(value)) return value;
        throw new ApiException(HttpStatus.BAD_REQUEST, "unknown survey presentation");
    }
}
