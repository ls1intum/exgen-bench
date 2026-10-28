package exgen.survey.rating;

import exgen.survey.study.Instrument.PartId;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * A step of the fixed sequence a rater moves through. The server derives the current step from
 * what it has stored, so a rater who reopens the link always resumes exactly where they stopped,
 * and no step can be skipped or revisited.
 *
 * @param position the assignment's position, for a part of an exercise
 * @param part the part of the exercise
 */
public record Step(Kind kind, int position, PartId part) {

    public enum Kind {
        CONSENT,
        BACKGROUND,
        ONBOARDING,
        CALIBRATION,
        CALIBRATION_REVIEW,
        PART,
        WAITING,
        EXIT,
        DONE,
        DECLINED;

        public String id() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** The steps every rater answers once, before the first exercise. */
    public static final List<Kind> ONCE =
            List.of(Kind.CONSENT, Kind.BACKGROUND, Kind.ONBOARDING, Kind.CALIBRATION, Kind.CALIBRATION_REVIEW);

    public static Step of(Kind kind) {
        return new Step(kind, 0, null);
    }

    public static Step part(int position, PartId part) {
        return new Step(Kind.PART, position, part);
    }

    /** The key a step's answers and timestamps are stored under, such as {@code exercise-1-B}. */
    public String key() {
        return kind == Kind.PART ? "exercise-" + position + "-" + part : kind.id();
    }

    /** Whether the step takes answers; the others only say where the rater stands. */
    public boolean answerable() {
        return kind != Kind.WAITING && kind != Kind.DONE && kind != Kind.DECLINED;
    }

    /**
     * The step a rater is on, given whether they declined, the keys of the steps they submitted,
     * and the positions of their assigned exercises in rating order.
     */
    public static Step current(boolean declined, Set<String> submitted, List<Integer> positions) {
        if (declined) {
            return of(Kind.DECLINED);
        }
        for (var kind : ONCE) {
            if (!submitted.contains(kind.id())) {
                return of(kind);
            }
        }
        for (var position : positions) {
            for (var part : PartId.values()) {
                var step = part(position, part);
                if (!submitted.contains(step.key())) {
                    return step;
                }
            }
        }
        // A reserve rater finishes the introduction early and waits until the study team assigns work.
        if (positions.isEmpty()) {
            return of(Kind.WAITING);
        }
        return submitted.contains(Kind.EXIT.id()) ? of(Kind.DONE) : of(Kind.EXIT);
    }
}
