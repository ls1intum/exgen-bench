package exgen.survey.web;

import exgen.survey.export.ExportArchive;
import exgen.survey.rating.AdminService;
import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.Views.AdminOverview;
import exgen.survey.study.LoadedStudy;
import exgen.survey.web.Requests.AssignRequest;
import exgen.survey.web.Requests.DeadlineRequest;
import exgen.survey.web.Requests.LinkRequest;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import java.util.Map;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The study team's API, behind the study team's link. */
@RestController
@RequestMapping("/api/admin")
class AdminController {
    private final AdminService admin;
    private final LoadedStudy loaded;
    private final SurveyStore store;

    AdminController(AdminService admin, LoadedStudy loaded, SurveyStore store) {
        this.admin = admin;
        this.loaded = loaded;
        this.store = store;
    }

    @GetMapping("/overview")
    AdminOverview overview() {
        return admin.overview();
    }

    @PostMapping("/assign")
    AdminOverview assign(@Valid @RequestBody AssignRequest body) {
        admin.assign(body.rater(), body.kind(), body.replaces(), body.exercises());
        return admin.overview();
    }

    @PostMapping("/deadline")
    AdminOverview deadline(@Valid @RequestBody DeadlineRequest body) {
        admin.deadline(body.rater(), body.deadline());
        return admin.overview();
    }

    /** The browser's origin, which {@link SameOriginFilter} checked, is the public one even behind a proxy. */
    @PostMapping("/link")
    Map<String, String> link(@RequestHeader("Origin") String origin, @Valid @RequestBody LinkRequest body) {
        return Map.of(
                "link",
                URI.create(origin).resolve("/r/" + admin.link(body.rater())).toString());
    }

    @GetMapping("/export.zip")
    ResponseEntity<byte[]> export(@RequestParam(name = "role", required = false) List<String> roles) {
        var included = roles == null || roles.isEmpty() ? List.of("main", "reserve") : roles;
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(loaded.study().id() + "-export.zip")
                                .build()
                                .toString())
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(ExportArchive.archive(loaded, store, included));
    }
}
