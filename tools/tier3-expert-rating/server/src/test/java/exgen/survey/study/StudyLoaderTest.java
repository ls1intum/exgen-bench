package exgen.survey.study;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class StudyLoaderTest {
    static final Path STUDY = Path.of("src/test/resources/study");
    static final Path INSTRUMENT = Path.of("../instrument.yaml");

    @TempDir
    Path directory;

    Path copy() throws IOException {
        try (Stream<Path> files = Files.walk(STUDY)) {
            for (var file : files.sorted(Comparator.naturalOrder()).toList()) {
                var target = directory.resolve(STUDY.relativize(file).toString());
                if (Files.isDirectory(file)) {
                    Files.createDirectories(target);
                } else {
                    Files.copy(file, target);
                }
            }
        }
        return directory;
    }

    @Test
    void loadsTheFrozenBuildWithTheInstrumentResolved() {
        var loaded = StudyLoader.load(STUDY, INSTRUMENT);
        assertThat(loaded.exercises()).containsKeys("E1", "M1", "L1", "CAL");
        assertThat(loaded.instrument().calibration().items())
                .extracting(Instrument.Item::id)
                .isNotEmpty();
        assertThat(loaded.instrument().onboarding().pages())
                .noneMatch(page -> page.body().contains("{materiality_rule}"));
    }

    @Test
    void refusesAnExerciseFileEditedAfterItWasBuilt() throws IOException {
        var study = copy();
        var manifest = StudyLoader.load(STUDY, INSTRUMENT).manifest().entry("E1");
        var file = study.resolve("exercises/" + manifest.id() + ".json");
        Files.writeString(file, Files.readString(file).replaceFirst("\\{", "{ "));
        assertThatThrownBy(() -> StudyLoader.load(study, INSTRUMENT))
                .hasMessageContaining("exercise E1 (" + manifest.id() + ") changed after it was built");
    }

    @Test
    void refusesABuildAnotherVersionWroteWithTheWayOut() throws IOException {
        var study = copy();
        var manifest = study.resolve("exercises/manifest.json");
        Files.writeString(
                manifest,
                Files.readString(manifest)
                        .replace("\"blinding_replacements\"", "\"diagrams\": \"none\", \"blinding_replacements\""));
        assertThatThrownBy(() -> StudyLoader.load(study, INSTRUMENT))
                .hasMessageContaining(
                        "built by another version of exgen-bench; rebuild them with: exgen survey build --rebuild");
    }

    @Test
    void refusesAStudyDesignedForAnotherInstrumentVersion() throws IOException {
        var study = copy();
        var definition = study.resolve("study.yaml");
        Files.writeString(
                definition,
                Files.readString(definition).replace("instrument_version: \"1\"", "instrument_version: \"2\""));
        assertThatThrownBy(() -> StudyLoader.load(study, INSTRUMENT))
                .hasMessageContaining("designed for instrument version 2");
    }
}
