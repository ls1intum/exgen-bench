package exgen.survey.rating;

/**
 * The pre-registered meaning of a readiness level for an instructor: ready (4 or 5) means only the
 * statement's wording changes, usable (3) means local edits, and not usable (1 or 2) means a
 * redesign. Two ratings of one exercise agree when they fall into the same class.
 */
public final class Readiness {
    private Readiness() {}

    public static String classOf(long level) {
        return level >= 4 ? "ready" : level == 3 ? "usable" : "not_usable";
    }
}
