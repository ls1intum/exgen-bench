package exgen.survey.study;

import static org.assertj.core.api.Assertions.assertThat;

import exgen.survey.study.AnswerRules.Issue;
import exgen.survey.study.Instrument.Item;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * The server's answer rules on the real instrument, against the cases the browser app's rules
 * ({@code shared/instrument.ts}) are tested with, so the two cannot drift apart unnoticed.
 */
class AnswerRulesTest {
    static final Instrument INSTRUMENT = StudyLoader.loadInstrument(Path.of("../instrument.yaml"));
    static final JsonMapper JSON = JsonMapper.builder().build();

    record IssueCase(String name, List<String> items, Map<String, Answer> answers, List<Issue> issues) {
        @Override
        public String toString() {
            return name;
        }
    }

    record NormalizedCase(
            String name, List<String> items, Map<String, Answer> answers, Map<String, Answer> normalized) {
        @Override
        public String toString() {
            return name;
        }
    }

    record Cases(String description, List<IssueCase> issues, List<NormalizedCase> normalized) {}

    static Cases cases() throws Exception {
        return JSON.readValue(
                Files.readString(Path.of("../shared/answer-rules.cases.json")), new TypeReference<Cases>() {});
    }

    static Stream<IssueCase> issueCases() throws Exception {
        return cases().issues().stream();
    }

    static Stream<NormalizedCase> normalizedCases() throws Exception {
        return cases().normalized().stream();
    }

    static List<Item> items(List<String> ids) {
        return ids.stream()
                .flatMap(id ->
                        id.equals("part:D") ? INSTRUMENT.itemsOf(Instrument.PartId.D).stream() : Stream.of(item(id)))
                .toList();
    }

    static Item item(String id) {
        return Stream.of(
                        INSTRUMENT.background().items().stream(),
                        INSTRUMENT.questionnaire().parts().stream().flatMap(part -> part.items().stream()),
                        INSTRUMENT.exit().items().stream())
                .flatMap(items -> items)
                .filter(candidate -> candidate.id().equals(id))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no item " + id));
    }

    @ParameterizedTest
    @MethodSource("issueCases")
    void findsTheIssuesTheBrowserAppFinds(IssueCase rule) {
        assertThat(AnswerRules.issues(items(rule.items()), rule.answers())).isEqualTo(rule.issues());
    }

    @ParameterizedTest
    @MethodSource("normalizedCases")
    void storesWhatTheBrowserAppWouldStore(NormalizedCase rule) {
        assertThat(AnswerRules.normalize(items(rule.items()), rule.answers())).isEqualTo(rule.normalized());
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
}
