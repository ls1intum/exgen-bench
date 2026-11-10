package exgen.survey.study;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

/** The frozen build of a study's exercises: each exercise's random ID and the digest of its file. */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record Manifest(String schemaVersion, String studyId, List<Entry> exercises) {

    /**
     * @param source where the exercise came from, study-team information only the preview shows;
     *     absent in a manifest that does not record it
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonIgnoreProperties({"blinding_replacements"})
    public record Entry(String code, String id, String phase, String sha256, Source source) {}

    /**
     * The benchmark case an exercise was built from. The run, attempt and system the manifest also
     * records can name the generator, so the server does not read them.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Source(String caseId) {}

    public Entry entry(String code) {
        return exercises.stream()
                .filter(entry -> entry.code().equals(code))
                .findFirst()
                .orElse(null);
    }
}
