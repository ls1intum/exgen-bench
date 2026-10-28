package exgen.survey.study;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

/** The frozen build of a study's exercises: each exercise's random ID and the digest of its file. */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record Manifest(String schemaVersion, String studyId, List<Entry> exercises) {

    /** Where an exercise came from is study-team information the server never needs. */
    @JsonIgnoreProperties({"source", "blinding_replacements"})
    public record Entry(String code, String id, String phase, String sha256) {}

    public Entry entry(String code) {
        return exercises.stream()
                .filter(entry -> entry.code().equals(code))
                .findFirst()
                .orElse(null);
    }
}
