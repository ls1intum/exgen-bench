package exgen.survey.study;

import static org.assertj.core.api.Assertions.assertThat;

import exgen.survey.study.AnswerRules.Issue;
import exgen.survey.study.Instrument.Item;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/** The rules of {@code shared/instrument.ts}, which the browser app applies first, on the real instrument. */
class AnswerRulesTest {
    static final Instrument INSTRUMENT = StudyLoader.loadInstrument(Path.of("../instrument.yaml"));

    static Item item(String id) {
        return Stream.of(
                        INSTRUMENT.background().items().stream(),
                        INSTRUMENT.questionnaire().parts().stream().flatMap(part -> part.items().stream()),
                        INSTRUMENT.exit().items().stream())
                .flatMap(items -> items)
                .filter(candidate -> candidate.id().equals(id))
                .findFirst()
                .orElseThrow();
    }

    static Answer value(Object value) {
        return new Answer(value, null, null, null);
    }

    static Map<String, Answer> answers(Object... pairs) {
        var answers = new LinkedHashMap<String, Answer>();
        for (int index = 0; index < pairs.length; index += 2) {
            answers.put((String) pairs[index], (Answer) pairs[index + 1]);
        }
        return answers;
    }

    @Test
    void asksTheElevenExerciseItemsTheTwoFindingItemsAndReadinessTwice() {
        var ids = INSTRUMENT.questionnaire().parts().stream()
                .flatMap(part -> part.items().stream())
                .filter(candidate -> candidate instanceof Instrument.ChoiceItem)
                .map(Item::id)
                .toList();
        assertThat(ids)
                .containsExactly(
                        "CL1", "CL2", "SO1", "OA1", "OA2", "OA3", "OA4", "DF1", "SC1", "SC2", "FB1", "RD1", "AF1",
                        "AF2", "RD2");
    }

    @Test
    void requiresTheReasonANoAsksFor() {
        var cl1 = List.of(item("CL1"));
        assertThat(AnswerRules.issues(cl1, answers("CL1", value("no"))))
                .containsExactly(new Issue("CL1", "needs “Where”"));
        assertThat(AnswerRules.issues(cl1, answers("CL1", new Answer("no", null, null, "  "))))
                .hasSize(1);
        // JavaScript's trim, which the app uses, also removes a no-break space.
        assertThat(AnswerRules.issues(cl1, answers("CL1", new Answer("no", null, null, " "))))
                .hasSize(1);
        assertThat(AnswerRules.issues(cl1, answers("CL1", new Answer("no", null, null, "Task 2"))))
                .isEmpty();
        assertThat(AnswerRules.issues(cl1, answers("CL1", value("yes")))).isEmpty();
    }

    @Test
    void requiresTheDirectionOfADifficultyMisfit() {
        var df1 = List.of(item("DF1"));
        assertThat(AnswerRules.issues(df1, answers("DF1", new Answer("no", null, null, "much code"))))
                .containsExactly(new Issue("DF1", "needs one of the follow-up choices"));
        assertThat(AnswerRules.issues(df1, answers("DF1", new Answer("no", null, "too_hard", "much code"))))
                .isEmpty();
        assertThat(AnswerRules.issues(df1, answers("DF1", new Answer("yes", null, "too_hard", null))))
                .containsExactly(new Issue("DF1", "has a follow-up choice the option does not offer"));
    }

    @Test
    void makesTheMostImportantChangeOptionalOnlyWhenTheExerciseDeploysAsIs() {
        var partD = INSTRUMENT.questionnaire().parts().get(3).items();
        assertThat(AnswerRules.issues(partD, answers("AF1", value("na"), "AF2", value("na"), "RD2", value(4))))
                .extracting(Issue::item)
                .containsExactly("CHG");
        assertThat(AnswerRules.issues(partD, answers("AF1", value("na"), "AF2", value("na"), "RD2", value(5))))
                .isEmpty();
    }

    @Test
    void refusesUnknownOptionsAndItemsAndAnExclusiveOptionCombinedWithOthers() {
        assertThat(AnswerRules.issues(List.of(item("B2")), answers("B2", value("forever"))))
                .containsExactly(new Issue("B2", "has an option that does not exist"));
        assertThat(AnswerRules.issues(
                        List.of(item("B2")), answers("B2", value("3_to_5"), "X9", new Answer(null, null, null, "?"))))
                .containsExactly(new Issue("X9", "is not part of this section"));
        assertThat(AnswerRules.issues(
                        List.of(item("B5")), answers("B5", new Answer(null, List.of("none", "student"), null, null))))
                .containsExactly(new Issue("B5", "combines an exclusive option with another"));
        // "4" is text, not the scale's number 4.
        assertThat(AnswerRules.issues(List.of(item("RD1")), answers("RD1", value("4"))))
                .containsExactly(new Issue("RD1", "has an option that does not exist"));
    }

    @Test
    void keepsOnlyWhatTheChosenOptionAsksForWhenAnswersAreStored() {
        assertThat(AnswerRules.normalize(
                        List.of(item("CL1"), item("REM")),
                        answers(
                                "CL1",
                                new Answer("yes", null, "x", "left over from an earlier No"),
                                "REM",
                                new Answer(null, null, null, "  none  "))))
                .isEqualTo(answers("CL1", value("yes"), "REM", new Answer(null, null, null, "none")));
    }
}
