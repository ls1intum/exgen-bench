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
        assertThat(loaded.exercises()).containsOnlyKeys("E1", "M1", "L1");
        assertThat(loaded.instrument().briefs().items())
                .extracting(Instrument.Item::id)
                .containsExactly("BR1", "BR2", "BR3");
        assertThat(loaded.instrument().onboarding().pages())
                .noneMatch(page -> page.body().contains("{materiality_rule}")
                        || page.body().contains("{exercise_minutes}"));
        // The four parts budget 5 + 7 + 3 + 3 minutes.
        assertThat(loaded.instrument().onboarding().pages())
                .anyMatch(page -> page.body().contains("about 18 minutes per exercise"));
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
                Files.readString(definition).replace("instrument_version: \"4\"", "instrument_version: \"9\""));
        assertThatThrownBy(() -> StudyLoader.load(study, INSTRUMENT))
                .hasMessageContaining("designed for instrument version 9");
    }

    @Test
    void refusesAStudyWithAPracticeExerciseThisInstrumentNoLongerHas() throws IOException {
        var study = copy();
        var definition = study.resolve("study.yaml");
        Files.writeString(
                definition,
                Files.readString(definition)
                        .replace("raters:\n", "calibration:\n  code: CAL\n  phase: early\n\nraters:\n"));
        assertThatThrownBy(() -> StudyLoader.load(study, INSTRUMENT)).hasMessageContaining("\"calibration\"");
    }
}
