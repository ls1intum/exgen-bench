package exgen.survey.web;

import exgen.survey.export.Csv;
import exgen.survey.export.JsonFormat;
import exgen.survey.rating.FindingsPresentation;
import exgen.survey.rating.RaterService;
import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.SurveyStore.Holder;
import exgen.survey.rating.Times;
import exgen.survey.rating.Views.Session;
import exgen.survey.study.LoadedStudy;
import exgen.survey.web.Requests.AnswersRequest;
import exgen.survey.web.Requests.ConsentRequest;
import exgen.survey.web.Requests.EventsRequest;
import exgen.survey.web.Requests.StepRequest;
import jakarta.validation.Valid;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The rater's API. Every request that changes state answers with the new session. */
@RestController
@RequestMapping("/api")
class RaterController {
    private final RaterService raters;
    private final LoadedStudy loaded;

    RaterController(RaterService raters, LoadedStudy loaded) {
        this.raters = raters;
        this.loaded = loaded;
    }

    @GetMapping("/session")
    Session session(
            @AuthenticationPrincipal Holder holder,
            @RequestHeader(value = FindingsPresentation.HEADER, required = false) String presentation) {
        return raters.session(holder, FindingsPresentation.fromHeader(presentation));
    }

    @PostMapping("/consent")
    Session consent(@AuthenticationPrincipal Holder.Rater holder, @Valid @RequestBody ConsentRequest body) {
        raters.consent(holder.rater(), body.accepted());
        return raters.session(holder);
    }

    @PostMapping("/step/open")
    Session open(
            @AuthenticationPrincipal Holder.Rater holder,
            @Valid @RequestBody StepRequest body,
            @RequestHeader(value = FindingsPresentation.HEADER, required = false) String presentation) {
        raters.open(holder.rater(), body.step(), FindingsPresentation.fromHeader(presentation));
        return raters.session(holder);
    }

    @PutMapping("/step/draft")
    Map<String, String> draft(
            @AuthenticationPrincipal Holder.Rater holder,
            @Valid @RequestBody AnswersRequest body,
            @RequestHeader(value = FindingsPresentation.HEADER, required = false) String presentation) {
        return Map.of(
                "savedAt",
                Times.iso(raters.draft(
                        holder.rater(), body.step(), body.answers(), FindingsPresentation.fromHeader(presentation))));
    }

    @PostMapping("/step/submit")
    ResponseEntity<Object> submit(
            @AuthenticationPrincipal Holder.Rater holder,
            @Valid @RequestBody AnswersRequest body,
            @RequestHeader(value = FindingsPresentation.HEADER, required = false) String presentation) {
        var issues = raters.submit(
                holder.rater(), body.step(), body.answers(), FindingsPresentation.fromHeader(presentation));
        if (!issues.isEmpty()) {
            var error = new LinkedHashMap<String, Object>();
            error.put("error", "some answers are missing");
            error.put("issues", issues);
            return ResponseEntity.unprocessableContent().body(error);
        }
        return ResponseEntity.ok(raters.session(holder));
    }

    @PostMapping("/events")
    ResponseEntity<Void> events(@AuthenticationPrincipal Holder.Rater holder, @Valid @RequestBody EventsRequest body) {
        raters.events(
                holder.rater(),
                body.step(),
                body.events().stream()
                        .map(event -> new SurveyStore.ViewEvent(event.type(), event.target()))
                        .toList());
        return ResponseEntity.status(HttpStatus.NO_CONTENT).build();
    }

    @GetMapping("/me/answers.csv")
    ResponseEntity<String> answersCsv(@AuthenticationPrincipal Holder.Rater holder) {
        var rows = new ArrayList<Map<String, Object>>();
        for (var step : raters.ownAnswers(holder.rater().id()).steps()) {
            // Consent stores the accepted statements, not item answers.
            if (step.step().equals("consent")) {
                continue;
            }
            for (var entry : step.answers().properties()) {
                var answer = entry.getValue();
                var row = new LinkedHashMap<String, Object>();
                row.put("step", step.step());
                row.put("item", entry.getKey());
                row.put(
                        "value",
                        answer.has("values")
                                ? String.join(
                                        ";",
                                        answer.get("values")
                                                .valueStream()
                                                .map(value -> value.asString())
                                                .toList())
                                : answer.has("value") ? answer.get("value").asString() : null);
                row.put("choice", answer.has("choice") ? answer.get("choice").asString() : null);
                row.put("text", answer.has("text") ? answer.get("text").asString() : null);
                row.put(
                        "findings_presentations",
                        step.findings_presentations().isEmpty()
                                ? null
                                : String.join(";", step.findings_presentations()));
                row.put("findings_presentation_at_submit", step.findings_presentation_at_submit());
                row.put(
                        "findings_presentation_mixed",
                        step.findings_presentations().isEmpty()
                                ? null
                                : step.findings_presentations().size() > 1);
                rows.add(row);
            }
        }
        return download(
                Csv.write(
                        List.of(
                                "step",
                                "item",
                                "value",
                                "choice",
                                "text",
                                "findings_presentations",
                                "findings_presentation_at_submit",
                                "findings_presentation_mixed"),
                        rows),
                "text/csv; charset=utf-8",
                holder.rater().id() + ".csv");
    }

    @GetMapping("/me/answers.json")
    ResponseEntity<String> answersJson(@AuthenticationPrincipal Holder.Rater holder) {
        return download(
                JsonFormat.write(raters.ownAnswers(holder.rater().id())),
                MediaType.APPLICATION_JSON_VALUE,
                holder.rater().id() + ".json");
    }

    private ResponseEntity<String> download(String body, String type, String name) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, type)
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(loaded.study().id() + "-" + name)
                                .build()
                                .toString())
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(body);
    }
}
