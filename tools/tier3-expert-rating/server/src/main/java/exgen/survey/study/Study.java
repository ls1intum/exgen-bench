package exgen.survey.study;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonValue;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

/**
 * A study as {@code study.yaml} defines it: who rates what, with which consent text. The server
 * reads what it runs on; where each exercise came from and how it was built is the builder's
 * business, and {@code exgen survey check} validates the whole file before a study is frozen.
 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
@JsonIgnoreProperties({"build"})
public record Study(
        String schemaVersion,
        String id,
        String title,
        String instrumentVersion,
        Contact contact,
        Map<Role, String> deadlines,
        Consent consent,
        int ratingsPerExercise,
        List<ExerciseEntry> exercises,
        Calibration calibration,
        List<Rater> raters) {

    public Study {
        deadlines = deadlines == null ? Map.of() : Map.copyOf(deadlines);
    }

    public enum Role {
        MAIN,
        RESERVE,
        PILOT,
        TEST;

        @JsonValue
        public String id() {
            return name().toLowerCase(Locale.ROOT);
        }

        public static Role of(String id) {
            return valueOf(id.toUpperCase(Locale.ROOT));
        }
    }

    public record Contact(String name, String email) {}

    public record Consent(String summary, String details, List<Statement> statements) {}

    public record Statement(String id, String text) {}

    @JsonIgnoreProperties({"source"})
    public record ExerciseEntry(String code, String phase) {}

    /** The practice exercise, with the study team's answers and a short reason each. */
    @JsonIgnoreProperties({"source"})
    public record Calibration(String code, String phase, Map<String, Reference> reference) {}

    public record Reference(Answer answer, String explanation) {}

    /** A rater; reserve raters receive their exercises during the study. */
    public record Rater(String id, Role role, List<String> exercises) {
        public Rater {
            exercises = List.copyOf(Objects.requireNonNullElse(exercises, List.of()));
        }
    }

    public ExerciseEntry exercise(String code) {
        return exercises.stream()
                .filter(entry -> entry.code().equals(code))
                .findFirst()
                .orElse(null);
    }
}
