package exgen.survey.rating;

import exgen.survey.study.Instrument;
import org.springframework.http.HttpStatus;

/** Identifies observed browser presentations, separately from the frozen instrument and exercise. */
public final class FindingsPresentation {
    public static final String HEADER = "X-Survey-Presentation";
    public static final String LEGACY = "legacy-unversioned";
    public static final String CATEGORIES = "categories-v1";

    private static final String EVIDENCE = "evidence-v1";

    private FindingsPresentation() {}

    static String forInstrument(String presentation, Instrument instrument) {
        return EVIDENCE.equals(presentation) && instrument.ratingExample() == null ? CATEGORIES : presentation;
    }

    public static String fromHeader(String value) {
        if (value == null) return LEGACY;
        if (CATEGORIES.equals(value) || EVIDENCE.equals(value)) return value;
        throw new ApiException(HttpStatus.BAD_REQUEST, "unknown survey presentation");
    }
}
