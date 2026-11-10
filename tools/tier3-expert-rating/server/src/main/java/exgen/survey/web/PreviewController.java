package exgen.survey.web;

import exgen.survey.rating.ApiException;
import exgen.survey.rating.Views.AdminStudyId;
import exgen.survey.rating.Views.PreviewEntry;
import exgen.survey.rating.Views.PreviewExercise;
import exgen.survey.rating.Views.PreviewList;
import exgen.survey.rating.Views.PreviewPart;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Manifest;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The study team's read-only preview of the frozen exercises: every part's material at once, as
 * raters see it, from the files the server loaded and verified at start. It opens no step, records
 * no event and writes nothing; behind the study team's link like every {@code /api/admin} path.
 */
@RestController
@RequestMapping("/api/admin/preview")
class PreviewController {
    /** The problem statement's first Markdown heading; {@code shared/exercise.ts} uses the same rule. */
    private static final Pattern HEADING = Pattern.compile("(?m)^#{1,6}[ \\t]+(.+?)(?:[ \\t]+#+)?[ \\t]*$");

    private final LoadedStudy loaded;

    PreviewController(LoadedStudy loaded) {
        this.loaded = loaded;
    }

    @GetMapping
    ResponseEntity<PreviewList> list() {
        var parts = loaded.instrument().questionnaire().parts().stream()
                .map(part -> new PreviewPart(part.id().name(), part.title(), part.opens(), part.material()))
                .toList();
        var exercises = loaded.manifest().exercises().stream()
                .filter(entry -> loaded.exercises().containsKey(entry.code()))
                .map(entry ->
                        new PreviewEntry(entry.code(), entry.id(), entry.phase(), title(entry), sourceCase(entry)))
                .toList();
        return fresh(new PreviewList(
                new AdminStudyId(loaded.study().id(), loaded.study().title()), true, parts, exercises));
    }

    @GetMapping("/{code}")
    ResponseEntity<PreviewExercise> exercise(@PathVariable String code) {
        var entry = loaded.manifest().entry(code);
        var exercise = loaded.exercises().get(code);
        if (entry == null || exercise == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "no such exercise");
        }
        var parts = loaded.instrument().questionnaire().parts();
        var material = loaded.instrument().materialThrough(parts.getLast().id());
        return fresh(new PreviewExercise(
                entry.code(),
                entry.id(),
                entry.phase(),
                title(entry),
                sourceCase(entry),
                entry.sha256(),
                LoadedStudy.viewOf(exercise, material)));
    }

    private String title(Manifest.Entry entry) {
        var matcher = HEADING.matcher(
                loaded.exercises().get(entry.code()).path("statement").asString(""));
        return matcher.find() && !matcher.group(1).isBlank() ? matcher.group(1).strip() : null;
    }

    private static String sourceCase(Manifest.Entry entry) {
        return entry.source() == null ? null : entry.source().caseId();
    }

    /** Material is study-team information here, so no cache keeps a copy. */
    private static <T> ResponseEntity<T> fresh(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
