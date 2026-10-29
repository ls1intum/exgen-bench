package exgen.survey.study;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

/**
 * The expert rating instrument: every question the survey asks, in the order it asks them, as
 * {@code instrument.yaml} defines it and the browser app receives it. The fields follow the YAML
 * file, so the JSON the app receives is the instrument the study team wrote.
 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record Instrument(
        String schemaVersion,
        String version,
        String title,
        String materialityRule,
        Section background,
        Onboarding onboarding,
        Questionnaire questionnaire,
        Exit exit,
        Exit briefs) {

    /** The four parts of an exercise's rating, in the order a rater answers them. */
    public enum PartId {
        A,
        B,
        C,
        D
    }

    /** What a rater may see of an exercise, the first opening first. */
    public static final List<String> MATERIAL = List.of("brief", "statement", "template", "diff", "tests", "findings");

    public record Section(String title, String intro, List<Item> items) {}

    public record Onboarding(String title, List<Page> pages) {}

    public record Page(String title, String body) {}

    public record Questionnaire(String title, String perspective, List<Part> parts) {}

    public record Part(PartId id, String title, int minutes, String opens, List<String> material, List<Item> items) {}

    /** A closing section with its time budget: looking back on the exercises, and the feedback on the briefs. */
    public record Exit(String title, int minutes, String intro, List<Item> items) {}

    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "kind")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = ChoiceItem.class, name = "choice"),
        @JsonSubTypes.Type(value = MultiItem.class, name = "multi"),
        @JsonSubTypes.Type(value = TextItem.class, name = "text")
    })
    public sealed interface Item permits ChoiceItem, MultiItem, TextItem {
        String id();

        String prompt();
    }

    /** One option out of several; {@code layout} defaults to a row of buttons. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ChoiceItem(
            String id,
            String dimension,
            String prompt,
            String lookFor,
            String note,
            String layout,
            Scale scale,
            List<Option> options)
            implements Item {
        public ChoiceItem {
            layout = Objects.requireNonNullElse(layout, "inline");
        }
    }

    /** Several options at once. */
    public record MultiItem(String id, String prompt, List<Option> options) implements Item {}

    /** Free text; it becomes optional when another item of its section has a given value. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record TextItem(String id, String prompt, String hint, boolean required, Condition optionalWhen)
            implements Item {}

    public record Condition(String item, Object value) {
        public Condition {
            value = OptionValues.of(value);
        }
    }

    public record Scale(String low, String high) {}

    /** An option; selecting an exclusive option of a multiple-choice item excludes all others. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Option(Object value, String label, String description, Detail detail, Boolean exclusive) {
        public Option {
            value = OptionValues.of(value);
            exclusive = Objects.requireNonNullElse(exclusive, false);
        }
    }

    /** The free text an option asks for, such as "Where", with an optional hint and closed follow-up. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Detail(String label, String hint, Boolean required, List<Choice> choices) {
        public Detail {
            required = Objects.requireNonNullElse(required, true);
        }
    }

    public record Choice(String value, String label) {}

    /** The questionnaire items of a part. */
    public List<Item> itemsOf(PartId part) {
        return questionnaire.parts().stream()
                .filter(candidate -> candidate.id() == part)
                .findFirst()
                .map(Part::items)
                .orElse(List.of());
    }

    /** Material open in a part: everything up to and including that part. */
    public List<String> materialThrough(PartId part) {
        var parts = questionnaire.parts();
        int index = parts.stream().map(Part::id).toList().indexOf(part);
        return parts.subList(0, index + 1).stream()
                .flatMap(candidate -> candidate.material().stream())
                .toList();
    }
}
