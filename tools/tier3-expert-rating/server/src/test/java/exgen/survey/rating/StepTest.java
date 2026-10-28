package exgen.survey.rating;

import static org.assertj.core.api.Assertions.assertThat;

import exgen.survey.rating.Step.Kind;
import exgen.survey.study.Instrument.PartId;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

class StepTest {
    static final List<String> ONCE =
            List.of("consent", "background", "onboarding", "calibration", "calibration_review");

    static Set<String> submitted(Stream<String> keys) {
        return Set.copyOf(keys.toList());
    }

    @Test
    void movesThroughTheIntroductionEveryPartOfEveryExerciseAndTheFinalSurvey() {
        var positions = List.of(1, 2);
        assertThat(Step.current(false, Set.of(), positions)).isEqualTo(Step.of(Kind.CONSENT));
        assertThat(Step.current(false, Set.copyOf(ONCE), positions)).isEqualTo(Step.part(1, PartId.A));
        assertThat(Step.current(
                        false,
                        submitted(Stream.concat(ONCE.stream(), Stream.of("exercise-1-A", "exercise-1-B"))),
                        positions))
                .isEqualTo(Step.part(1, PartId.C));
        var rated = Stream.of("A", "B", "C", "D")
                .flatMap(part -> Stream.of("exercise-1-" + part, "exercise-2-" + part))
                .toList();
        var all = Stream.concat(ONCE.stream(), rated.stream()).toList();
        assertThat(Step.current(false, Set.copyOf(all), positions)).isEqualTo(Step.of(Kind.EXIT));
        assertThat(Step.current(false, submitted(Stream.concat(all.stream(), Stream.of("exit"))), positions))
                .isEqualTo(Step.of(Kind.DONE));
        assertThat(Step.part(2, PartId.B).key()).isEqualTo("exercise-2-B");
    }

    @Test
    void letsAReserveRaterWaitUntilExercisesAreAssignedAndEndsAtADecline() {
        assertThat(Step.current(false, Set.copyOf(ONCE), List.of())).isEqualTo(Step.of(Kind.WAITING));
        assertThat(Step.current(true, Set.of(), List.of(1))).isEqualTo(Step.of(Kind.DECLINED));
        assertThat(Step.of(Kind.WAITING).answerable()).isFalse();
    }

    @Test
    void groupsTheFiveReadinessLevelsIntoThePreRegisteredClasses() {
        assertThat(Stream.of(1L, 2L, 3L, 4L, 5L).map(Readiness::classOf))
                .containsExactly("not_usable", "not_usable", "usable", "ready", "ready");
    }
}
