package exgen.survey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import exgen.survey.rating.RaterService;
import exgen.survey.rating.SurveyStore;
import exgen.survey.study.Instrument;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Manifest;
import exgen.survey.study.Study;
import jakarta.servlet.http.Cookie;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The survey server against the demo study's frozen build and a real PostgreSQL. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "survey.study=src/test/resources/study",
            "survey.web=src/test/resources/web",
            "survey.secure-cookies=false",
            "survey.legal.imprint=https://example.org/imprint",
            "survey.legal.privacy=src/test/resources/legal/privacy.md"
        })
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class ServerTest {
    static final String HOST = "survey.example.org";

    @Autowired
    MockMvc mvc;

    @Autowired
    SurveyStore store;

    @Autowired
    LoadedStudy loaded;

    @Autowired
    RaterService raters;

    @Autowired
    JsonMapper json;

    @Autowired
    JdbcClient database;

    @LocalServerPort
    int port;

    /** Every test starts from the study as frozen, before anyone answered. */
    @BeforeEach
    void reset() {
        database.sql("TRUNCATE step, event, link, change_log").update();
        database.sql("DELETE FROM assignment WHERE kind <> 'planned'").update();
        database.sql("UPDATE assignment SET removed_at = NULL").update();
        database.sql("DELETE FROM assignment WHERE rater_id IN (SELECT id FROM rater WHERE added_at IS NOT NULL)")
                .update();
        database.sql("DELETE FROM rater WHERE added_at IS NOT NULL").update();
        database.sql("DELETE FROM frozen WHERE key LIKE 'plan:N%'").update();
        for (var rater : loaded.study().raters()) {
            database.sql(
                            "UPDATE rater SET declined_at = NULL, withdrawn_at = NULL, deadline = CAST(? AS date) WHERE id = ?")
                    .params(loaded.study().deadlines().get(rater.role()), rater.id())
                    .update();
        }
    }

    /** A browser holding a holder's session cookie; {@code null} is the study team. */
    final class Browser {
        final Cookie cookie;
        String presentation;

        Browser(String holder) throws Exception {
            this(store.issueLink(holder), true);
        }

        /** A browser that opens a personal link it was given. */
        Browser(String token, boolean given) throws Exception {
            var exchange = mvc.perform(request(HttpMethod.GET, "/r/" + token))
                    .andReturn()
                    .getResponse();
            assertThat(exchange.getStatus()).isEqualTo(303);
            var header = exchange.getHeader("Set-Cookie");
            assertThat(header).contains("HttpOnly").contains("SameSite=Strict");
            var pair = header.substring(0, header.indexOf(';')).split("=", 2);
            cookie = new Cookie(pair[0], pair[1]);
        }

        MvcResult call(HttpMethod method, String path, Object body) throws Exception {
            return call(method, path, body, "http://" + HOST);
        }

        MvcResult call(HttpMethod method, String path, Object body, String origin) throws Exception {
            var request =
                    request(method, path).cookie(cookie).header("Host", HOST).header("Origin", origin);
            if (presentation != null) request.header("X-Survey-Presentation", presentation);
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body));
            }
            return mvc.perform(request).andReturn();
        }

        /** A request that must succeed, and the session it answers with. */
        JsonNode session(HttpMethod method, String path, Object body) throws Exception {
            var result = call(method, path, body);
            assertThat(result.getResponse().getStatus())
                    .as(result.getResponse().getContentAsString())
                    .isEqualTo(200);
            return json.readTree(result.getResponse().getContentAsString());
        }

        JsonNode consent() throws Exception {
            return session(HttpMethod.POST, "/api/consent", Map.of("accepted", List.of("participate", "publish")));
        }

        /** Answer the current step with the first option of every item, and a reason wherever one is asked. */
        JsonNode complete(JsonNode current) throws Exception {
            var step = current.get("step");
            var instrument = current.get("instrument");
            var items = switch (step.get("kind").asString()) {
                case "background", "exit", "briefs" ->
                    instrument.get(step.get("kind").asString()).get("items");
                case "part" -> {
                    JsonNode found = null;
                    for (var part : instrument.get("questionnaire").get("parts")) {
                        if (part.get("id").equals(step.get("part"))) {
                            found = part.get("items");
                        }
                    }
                    yield found;
                }
                default -> json.createArrayNode();
            };
            var answers = new LinkedHashMap<String, Object>();
            for (var item : items) {
                var answer = new LinkedHashMap<String, Object>();
                if (item.get("kind").asString().equals("text")) {
                    answer.put("text", "A reason.");
                } else {
                    var option = item.get("options").get(0);
                    if (item.get("kind").asString().equals("multi")) {
                        answer.put("values", List.of(option.get("value").asString()));
                    } else {
                        answer.put("value", option.get("value"));
                    }
                    if (option.has("detail")) {
                        answer.put("text", "A reason.");
                        if (option.get("detail").has("choices")) {
                            answer.put(
                                    "choice",
                                    option.get("detail").get("choices").get(0).get("value"));
                        }
                    }
                }
                answers.put(item.get("id").asString(), answer);
            }
            return session(
                    HttpMethod.POST,
                    "/api/step/submit",
                    Map.of("step", step.get("key").asString(), "answers", answers));
        }

        /** Consent, the introduction and the background questions. */
        JsonNode throughBackground() throws Exception {
            assertThat(consent().at("/step/kind").asString()).isEqualTo("onboarding");
            var current =
                    session(HttpMethod.POST, "/api/step/submit", Map.of("step", "onboarding", "answers", Map.of()));
            assertThat(current.at("/step/kind").asString()).isEqualTo("background");
            return complete(current);
        }

        /** Every part of the exercise the rater is on, from the given session on. */
        JsonNode throughExercise(JsonNode current) throws Exception {
            for (var part : List.of("A", "B", "C", "D")) {
                assertThat(current.at("/step/part").asString()).isEqualTo(part);
                current = complete(session(
                        HttpMethod.POST,
                        "/api/step/open",
                        Map.of("step", current.at("/step/key").asString())));
            }
            return current;
        }
    }

    @Nested
    class TheDatabase {
        @Test
        void keepsARatersPlannedExercisesFixedOnceTheStudyHasStarted() {
            var study = loaded.study();
            var raters = study.raters().stream()
                    .map(rater -> rater.id().equals("R1")
                            ? new Study.Rater("R1", rater.role(), List.of("M1", "E1", "L1"))
                            : rater)
                    .toList();
            var changed = new LoadedStudy(
                    new Study(
                            study.schemaVersion(),
                            study.id(),
                            study.title(),
                            study.instrumentVersion(),
                            study.contact(),
                            study.deadlines(),
                            study.consent(),
                            study.ratingsPerExercise(),
                            study.exercises(),
                            raters),
                    loaded.instrument(),
                    loaded.manifest(),
                    loaded.exercises(),
                    loaded.idOf());
            assertThatThrownBy(() -> store.synchronize(changed)).hasMessageContaining("the plan of R1 changed");
        }

        @Test
        void refusesExercisesRebuiltOrAnInstrumentRewordedAfterTheStudyStarted() {
            var manifest = loaded.manifest();
            var rebuilt = new Manifest(
                    manifest.schemaVersion(),
                    manifest.studyId(),
                    manifest.exercises().stream()
                            .map(entry -> entry.code().equals("E1")
                                    ? new Manifest.Entry(entry.code(), entry.id(), entry.phase(), "0".repeat(64))
                                    : entry)
                            .toList());
            assertThatThrownBy(() -> store.synchronize(new LoadedStudy(
                            loaded.study(), loaded.instrument(), rebuilt, loaded.exercises(), loaded.idOf())))
                    .hasMessageContaining("E1 was rebuilt");
            var instrument = loaded.instrument();
            var reworded = new Instrument(
                    instrument.schemaVersion(),
                    instrument.version(),
                    instrument.title(),
                    "A different rule.",
                    instrument.background(),
                    instrument.onboarding(),
                    instrument.questionnaire(),
                    instrument.exit(),
                    instrument.briefs());
            assertThatThrownBy(() -> store.synchronize(new LoadedStudy(
                            loaded.study(), reworded, loaded.manifest(), loaded.exercises(), loaded.idOf())))
                    .hasMessageContaining("the instrument changed");
        }

        @Test
        void revokesAHoldersEarlierLinkWhenANewOneIsIssued() {
            var first = store.issueLink("R1");
            var second = store.issueLink("R1");
            assertThat(store.holderOf(first)).isEmpty();
            assertThat(store.holderOf(second))
                    .get()
                    .isInstanceOfSatisfying(
                            SurveyStore.Holder.Rater.class,
                            holder -> assertThat(holder.rater().id()).isEqualTo("R1"));
            var team = store.issueLink(null);
            assertThat(store.holderOf(team)).containsInstanceOf(SurveyStore.Holder.Admin.class);
            store.issueLink(null);
            assertThat(store.holderOf(team)).isEmpty();
        }
    }

    @Test
    void revealsEachPartsMaterialOnlyAfterThePreviousPartIsStored() throws Exception {
        var rater = new Browser("T1");
        var current = rater.throughBackground();
        assertThat(current.at("/step/kind").asString()).isEqualTo("part");
        assertThat(current.at("/step/part").asString()).isEqualTo("A");
        assertThat(current.at("/step/opened").asBoolean()).isFalse();
        assertThat(current.get("step").has("exercise")).isFalse();
        assertThat(rater.call(HttpMethod.POST, "/api/step/open", Map.of("step", "exercise-1-B"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(409);

        current = rater.session(HttpMethod.POST, "/api/step/open", Map.of("step", "exercise-1-A"));
        assertThat(current.at("/step/exercise").propertyNames())
                .containsExactlyInAnyOrder("brief", "facts", "id", "phase", "statement");

        rater.complete(current);
        current = rater.session(HttpMethod.POST, "/api/step/open", Map.of("step", "exercise-1-B"));
        assertThat(current.at("/step/exercise").has("template")).isTrue();
        assertThat(current.at("/step/exercise").has("tests")).isFalse();
        assertThat(current.at("/step/earlier/A/CL1")).isEqualTo(json.readTree("{\"value\":\"yes\"}"));
    }

    @Test
    void refusesIncompleteAnswersItemByItemAndRequestsFromAnotherOrigin() throws Exception {
        var rater = new Browser("R1");
        rater.consent();
        var current =
                rater.session(HttpMethod.POST, "/api/step/submit", Map.of("step", "onboarding", "answers", Map.of()));
        var incomplete = rater.call(
                HttpMethod.POST,
                "/api/step/submit",
                Map.of("step", "background", "answers", Map.of("B2", Map.of("value", "3_to_5"))));
        assertThat(incomplete.getResponse().getStatus()).isEqualTo(422);
        var issues =
                json.readTree(incomplete.getResponse().getContentAsString()).get("issues");
        assertThat(issues.valueStream().map(issue -> issue.get("item").asString()))
                .contains("B1");
        assertThat(current.at("/step/kind").asString()).isEqualTo("background");

        var draft = Map.of("step", "background", "answers", Map.of());
        assertThat(rater.call(HttpMethod.PUT, "/api/step/draft", draft, "https://elsewhere.example")
                        .getResponse()
                        .getStatus())
                .isEqualTo(403);
        // Behind a TLS-terminating proxy, the browser's origin is HTTPS while the server sees HTTP.
        assertThat(rater.call(HttpMethod.PUT, "/api/step/draft", draft, "https://" + HOST)
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
    }

    @Test
    void refusesMalformedOversizedAndNonJsonRequests() throws Exception {
        var rater = new Browser("T3");
        var unknownField = rater.call(HttpMethod.POST, "/api/consent", Map.of("accepted", List.of(), "extra", 1));
        assertThat(unknownField.getResponse().getStatus()).isEqualTo(400);
        var badItem = rater.call(
                HttpMethod.PUT, "/api/step/draft", Map.of("step", "consent", "answers", Map.of("lower", Map.of())));
        assertThat(badItem.getResponse().getStatus()).isEqualTo(400);
        var text = mvc.perform(request(HttpMethod.POST, "/api/consent")
                        .cookie(rater.cookie)
                        .header("Host", HOST)
                        .header("Origin", "http://" + HOST)
                        .contentType(MediaType.TEXT_PLAIN)
                        .content("accepted"))
                .andReturn();
        assertThat(text.getResponse().getStatus()).isEqualTo(415);
        var large = rater.call(
                HttpMethod.PUT,
                "/api/step/draft",
                Map.of("step", "consent", "answers", Map.of("B1", Map.of("text", "x".repeat(300_000)))));
        assertThat(large.getResponse().getStatus()).isEqualTo(413);
    }

    @Test
    void checksEveryStateChangingRequestWhateverItsPathLooksLike() throws Exception {
        var rater = new Browser("T1");
        // /%61pi/ is /api/ once decoded; the origin check must not depend on how the path is written.
        var encoded = mvc.perform(request(HttpMethod.POST, URI.create("/%61pi/step/open"))
                        .cookie(rater.cookie)
                        .header("Host", HOST)
                        .header("Origin", "https://elsewhere.example")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"step\":\"consent\"}"))
                .andReturn()
                .getResponse();
        assertThat(encoded.getStatus()).isEqualTo(403);
        assertThat(encoded.getHeader("Content-Security-Policy")).contains("default-src 'self'");
        // A body sent in chunks, without a length, is cut off where it grows too large.
        var huge = "{\"step\":\"consent\",\"answers\":{\"B1\":{\"text\":\"" + "x".repeat(300_000) + "\"}}}";
        var chunked = HttpClient.newHttpClient()
                .send(
                        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/step/draft"))
                                .header("Cookie", rater.cookie.getName() + "=" + rater.cookie.getValue())
                                .header("Origin", "http://localhost:" + port)
                                .header("Content-Type", "application/json")
                                .PUT(HttpRequest.BodyPublishers.ofInputStream(
                                        () -> new ByteArrayInputStream(huge.getBytes(StandardCharsets.UTF_8))))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
        assertThat(chunked.statusCode()).isEqualTo(413);
    }

    @Test
    void readsRequestsAsStrictlyAsTheBrowserAppWritesThem() throws Exception {
        var rater = new Browser("T1");
        assertThat(rater.call(HttpMethod.POST, "/api/step/open", Map.of("step", 5))
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
        var team = new Browser(null);
        assertThat(team.call(
                                HttpMethod.POST,
                                "/api/admin/deadline",
                                Map.of("rater", "R1", "deadline", "2026-12-01T23:30:00"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
    }

    @Test
    void keepsTheStudyTeamsEndpointsFromRatersAndServesSecurityHeaders() throws Exception {
        var rater = new Browser("R2");
        assertThat(rater.call(HttpMethod.GET, "/api/admin/overview", null)
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        var team = new Browser(null);
        assertThat(team.call(HttpMethod.POST, "/api/consent", Map.of("accepted", List.of()))
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        var page = mvc.perform(request(HttpMethod.GET, "/")).andReturn().getResponse();
        assertThat(page.getHeader("Content-Security-Policy")).contains("default-src 'self'");
        assertThat(page.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
        assertThat(page.getHeader("Cache-Control")).isEqualTo("no-cache");
        assertThat(rater.call(HttpMethod.GET, "/api/unknown", null)
                        .getResponse()
                        .getStatus())
                .isEqualTo(404);
        // Without a link, the API does not tell which endpoints exist.
        assertThat(mvc.perform(request(HttpMethod.GET, "/api/unknown"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        // Spring Security's firewall refuses a path that leaves its directory before it reaches a file.
        assertThat(mvc.perform(request(HttpMethod.GET, "/assets/../../build.gradle.kts"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
        assertThat(mvc.perform(request(HttpMethod.GET, "/assets/missing.js"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(404);
    }

    @Test
    void assignsExercisesToAReserveRaterWhoWaitsForThem() throws Exception {
        var reserve = new Browser("R2");
        var current = reserve.throughBackground();
        assertThat(current.at("/step/kind").asString()).isEqualTo("waiting");

        var team = new Browser(null);
        var assign = new Object() {
            int status(Map<String, Object> changes) throws Exception {
                var body = new LinkedHashMap<String, Object>(Map.of("rater", "R2", "exercises", List.of("E1")));
                body.putAll(changes);
                return team.call(HttpMethod.POST, "/api/admin/assign", body)
                        .getResponse()
                        .getStatus();
            }
        };
        var none = new LinkedHashMap<String, Object>();
        none.put("replaces", null);
        assertThat(assign.status(with(none, "rater", "R1", "kind", "tie_breaker")))
                .isEqualTo(400);
        assertThat(assign.status(Map.of("kind", "tie_breaker", "replaces", "R1")))
                .isEqualTo(400);
        assertThat(assign.status(with(none, "kind", "backup"))).isEqualTo(400);
        assertThat(assign.status(Map.of("kind", "backup", "replaces", "R2"))).isEqualTo(400);
        assertThat(assign.status(Map.of("kind", "backup", "replaces", "R1", "exercises", List.of("E1", "X9"))))
                .isEqualTo(400);
        assertThat(assign.status(Map.of("kind", "backup", "replaces", "R1"))).isEqualTo(200);

        current = reserve.session(HttpMethod.GET, "/api/session", null);
        for (var part : List.of("A", "B", "C", "D")) {
            assertThat(current.at("/step/part").asString()).isEqualTo(part);
            current = reserve.complete(
                    reserve.session(HttpMethod.POST, "/api/step/open", Map.of("step", "exercise-1-" + part)));
        }
        assertThat(current.at("/step/kind").asString()).isEqualTo("exit");

        // The backup's rating stands in for R1's, so E1 has its planned rating.
        var overview = team.session(HttpMethod.GET, "/api/admin/overview", null);
        assertThat(find(overview.get("raters"), "id", "R2").get("exercises"))
                .isEqualTo(
                        json.readTree(
                                "[{\"code\":\"E1\",\"kind\":\"backup\",\"replaces\":\"R1\",\"parts\":4,\"started\":true,\"complete\":true}]"));
        var e1 = find(overview.get("exercises"), "code", "E1");
        assertThat(e1.get("readiness")).isEqualTo(json.readTree("[5]"));
        assertThat(e1.get("tieBreaker")).isEqualTo(json.readTree("[]"));
        assertThat(e1.get("agreement").asString()).isEqualTo("agree");
    }

    @Test
    void addsARaterDuringTheStudyWhoRatesTheStudysExercises() throws Exception {
        var team = new Browser(null);
        var body = new LinkedHashMap<String, Object>();
        body.put("id", "P7");
        body.put("role", "pilot");
        body.put("deadline", "2026-12-01");
        body.put("exercises", List.of("M1", "E1"));
        var added = team.call(HttpMethod.POST, "/api/admin/raters", body, "https://" + HOST);
        assertThat(added.getResponse().getStatus()).isEqualTo(200);
        var answer = json.readTree(added.getResponse().getContentAsString());
        var link = answer.get("link").asString();
        assertThat(link).startsWith("https://" + HOST + "/r/");
        var p7 = find(answer.at("/overview/raters"), "id", "P7");
        assertThat(p7.get("added").asBoolean()).isTrue();
        var files = unzip(team.call(HttpMethod.GET, "/api/admin/export.zip?role=pilot", null)
                .getResponse()
                .getContentAsByteArray());
        assertThat(files.get("raters.csv")).containsPattern("P7,pilot,,,,2026-12-01,\\d{4}-");
        assertThat(p7.get("link").asBoolean()).isTrue();
        assertThat(p7.get("exercises")
                        .valueStream()
                        .map(exercise -> exercise.get("code").asString() + ":"
                                + exercise.get("kind").asString()))
                .containsExactly("M1:additional", "E1:additional");
        assertThat(p7.at("/progress/total").asInt()).isEqualTo(3 + 4 * 2 + 2);

        // The link the dashboard showed lets the new rater in, and they rate in the given order.
        var rater = new Browser(link.substring(link.indexOf("/r/") + 3), true);
        var current = rater.throughBackground();
        assertThat(current.at("/step/key").asString()).isEqualTo("exercise-1-A");
        assertThat(store.assignments("P7").getFirst().exercise()).isEqualTo("M1");

        assertThat(team.call(HttpMethod.POST, "/api/admin/raters", body)
                        .getResponse()
                        .getStatus())
                .as("an ID twice")
                .isEqualTo(400);
        body.put("id", "P8");
        body.put("role", "observer");
        assertThat(team.call(HttpMethod.POST, "/api/admin/raters", body)
                        .getResponse()
                        .getStatus())
                .as("an unknown role")
                .isEqualTo(400);
        var changes = json.readTree(team.call(HttpMethod.GET, "/api/admin/overview", null)
                        .getResponse()
                        .getContentAsString())
                .get("changes");
        assertThat(changes.valueStream().map(change -> change.get("action").asString()))
                .contains("rater added", "link issued");
    }

    @Test
    void removesOnlyAssignmentsNobodyStartedAndKeepsThePlanRecognisable() throws Exception {
        var team = new Browser(null);
        var rater = new Browser("R1");
        rater.throughBackground();
        rater.session(HttpMethod.POST, "/api/step/open", Map.of("step", "exercise-1-A"));
        var started = team.call(HttpMethod.POST, "/api/admin/unassign", Map.of("rater", "R1", "exercise", "E1"));
        assertThat(started.getResponse().getStatus()).isEqualTo(409);
        assertThat(team.call(HttpMethod.POST, "/api/admin/unassign", Map.of("rater", "R1", "exercise", "L1"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
        assertThat(store.assignments("R1")).extracting(row -> row.exercise()).containsExactly("E1", "M1");
        // A removed planned assignment is marked, not deleted, so the server still starts on the plan.
        store.synchronize(loaded);
        // And the exercise can be assigned again later, after the others.
        team.session(
                HttpMethod.POST,
                "/api/admin/assign",
                Map.of("rater", "R1", "kind", "additional", "exercises", List.of("L1")));
        assertThat(store.assignments("R1")).extracting(row -> row.position()).containsExactly(1, 2, 4);
        assertThat(team.call(HttpMethod.POST, "/api/admin/unassign", Map.of("rater", "R1", "exercise", "X9"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(404);
    }

    /** The study with its raters changed, as an edited study.yaml would load. */
    LoadedStudy withRaters(java.util.function.UnaryOperator<List<Study.Rater>> change) {
        var study = loaded.study();
        return new LoadedStudy(
                new Study(
                        study.schemaVersion(),
                        study.id(),
                        study.title(),
                        study.instrumentVersion(),
                        study.contact(),
                        study.deadlines(),
                        study.consent(),
                        study.ratingsPerExercise(),
                        study.exercises(),
                        change.apply(new java.util.ArrayList<>(study.raters()))),
                loaded.instrument(),
                loaded.manifest(),
                loaded.exercises(),
                loaded.idOf());
    }

    @Test
    void freezesEveryRatersPlanAndLogsRatersAddedToTheStudyLater() throws Exception {
        // A reserve rater's empty plan is recorded too, so a later plan for them is refused.
        assertThatThrownBy(() -> store.synchronize(withRaters(raters -> raters.stream()
                        .map(rater ->
                                rater.id().equals("R2") ? new Study.Rater("R2", rater.role(), List.of("M1")) : rater)
                        .toList())))
                .hasMessageContaining("the plan of R2 changed");
        // Once a rater has answered, a rater new to study.yaml is marked as added, and logged.
        new Browser("T1").consent();
        store.synchronize(withRaters(raters -> {
            raters.add(new Study.Rater("N1", Study.Role.PILOT, List.of("E1")));
            return raters;
        }));
        assertThat(store.rater("N1").orElseThrow().addedAt()).isNotNull();
        assertThat(store.assignments("N1")).extracting(row -> row.kind()).containsExactly("planned");
        assertThat(store.changes())
                .extracting(change -> change.detail())
                .contains("N1 (pilot) added to study.yaml after the study started");
    }

    @Test
    void countsABackupAfterTheOriginalUnstartedAssignmentIsRemoved() throws Exception {
        var team = new Browser(null);
        team.session(HttpMethod.POST, "/api/admin/unassign", Map.of("rater", "R1", "exercise", "E1"));
        team.session(
                HttpMethod.POST,
                "/api/admin/assign",
                Map.of("rater", "R2", "kind", "backup", "replaces", "R1", "exercises", List.of("E1")));
        var reserve = new Browser("R2");
        var current = reserve.throughBackground();
        for (var part : List.of("A", "B", "C", "D")) {
            current = reserve.complete(reserve.session(
                    HttpMethod.POST,
                    "/api/step/open",
                    Map.of("step", current.at("/step/key").asString())));
        }
        var overview = team.session(HttpMethod.GET, "/api/admin/overview", null);
        var exercise = find(overview.get("exercises"), "code", "E1");
        assertThat(exercise.get("readiness")).isEqualTo(json.readTree("[5]"));
        assertThat(exercise.get("agreement").asString()).isEqualTo("agree");
    }

    @Test
    void countsAPlannedRatingOnceAndExportsTheOrderOfTheSession() throws Exception {
        var team = new Browser(null);
        team.session(
                HttpMethod.POST,
                "/api/admin/assign",
                Map.of("rater", "R2", "kind", "backup", "replaces", "R1", "exercises", List.of("E1")));
        team.session(HttpMethod.POST, "/api/admin/unassign", Map.of("rater", "R1", "exercise", "M1"));
        for (var holder : List.of("R1", "R2")) {
            var rater = new Browser(holder);
            var current = rater.throughBackground();
            for (var part : List.of("A", "B", "C", "D")) {
                current = rater.complete(rater.session(
                        HttpMethod.POST,
                        "/api/step/open",
                        Map.of("step", current.at("/step/key").asString())));
            }
        }
        // R1 finished E1 itself, so the backup R2 rated for them does not count a second time.
        var overview = team.session(HttpMethod.GET, "/api/admin/overview", null);
        assertThat(find(overview.get("exercises"), "code", "E1")
                        .get("readiness")
                        .size())
                .isEqualTo(1);
        var files = unzip(team.call(HttpMethod.GET, "/api/admin/export.zip?role=main&role=reserve", null)
                .getResponse()
                .getContentAsByteArray());
        assertThat(files.get("raters.csv").split("\n")[0]).endsWith(",added_at");
        // R1's second exercise is L1 once M1 is removed, whatever position L1 was planned at.
        var data = json.readTree(files.get("data.json"));
        assertThat(data.at("/tables/ratings")
                        .valueStream()
                        .filter(row -> row.get("rater_id").asString().equals("R1"))
                        .map(row -> row.get("exercise_code").asString() + "@"
                                + row.get("position").asInt()))
                .contains("E1@1");
    }

    @Test
    void revokesALinkAndExportsEveryChange() throws Exception {
        var team = new Browser(null);
        var rater = new Browser("T3");
        team.session(HttpMethod.POST, "/api/admin/revoke", Map.of("rater", "T3"));
        assertThat(rater.call(HttpMethod.GET, "/api/session", null)
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        team.session(HttpMethod.POST, "/api/admin/deadline", Map.of("rater", "T3", "deadline", "2026-12-24"));
        var files = unzip(team.call(HttpMethod.GET, "/api/admin/export.zip?role=test", null)
                .getResponse()
                .getContentAsByteArray());
        assertThat(files.get("changes.csv"))
                .startsWith("at,action,rater_id,detail\n")
                .contains(",link revoked,T3,")
                .contains(",deadline changed,T3,T3 until 2026-12-24");
        assertThat(files.get("CODEBOOK.md")).contains("## changes.csv");
    }

    @Test
    void letsTheStudyTeamIssueRaterLinksAndDeadlinesAndNothingElse() throws Exception {
        var team = new Browser(null);
        var proxied = team.call(HttpMethod.POST, "/api/admin/link", Map.of("rater", "R1"), "https://" + HOST);
        assertThat(json.readTree(proxied.getResponse().getContentAsString())
                        .get("link")
                        .asString())
                .startsWith("https://" + HOST + "/r/");
        var none = new LinkedHashMap<String, Object>();
        none.put("rater", null);
        assertThat(team.call(HttpMethod.POST, "/api/admin/link", none)
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
        assertThat(team.call(HttpMethod.POST, "/api/admin/deadline", Map.of("rater", "R9", "deadline", "2026-12-01"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(404);
        var moved =
                team.session(HttpMethod.POST, "/api/admin/deadline", Map.of("rater", "R1", "deadline", "2026-12-01"));
        assertThat(find(moved.get("raters"), "id", "R1").get("deadline").asString())
                .isEqualTo("2026-12-01");
    }

    @Test
    void endsAtADeclineAndServesARaterTheirOwnAnswers() throws Exception {
        var declining = new Browser("T3");
        var current = declining.session(HttpMethod.POST, "/api/consent", Map.of("accepted", List.of()));
        assertThat(current.at("/step/kind").asString()).isEqualTo("declined");
        assertThat(declining
                        .call(HttpMethod.POST, "/api/step/submit", Map.of("step", "declined", "answers", Map.of()))
                        .getResponse()
                        .getStatus())
                .isEqualTo(409);

        var rater = new Browser("T2");
        rater.complete(rater.consent());
        var csv = rater.call(HttpMethod.GET, "/api/me/answers.csv", null).getResponse();
        assertThat(csv.getStatus()).isEqualTo(200);
        assertThat(csv.getHeader("Content-Disposition")).contains("expert-rating-demo-T2.csv");
        assertThat(csv.getContentAsString().split("\n")[0])
                .isEqualTo(
                        "step,item,value,choice,text,findings_presentations,findings_presentation_at_submit,findings_presentation_mixed");
        var answers = json.readTree(rater.call(HttpMethod.GET, "/api/me/answers.json", null)
                .getResponse()
                .getContentAsString());
        assertThat(answers.get("rater").asString()).isEqualTo("T2");
        assertThat(answers.at("/steps/0/step").asString()).isEqualTo("consent");
    }

    @Test
    void deletesAWithdrawnRatersAnswers() throws Exception {
        var rater = new Browser("T2");
        rater.consent();
        assertThat(store.steps("T2")).isNotEmpty();
        store.withdraw("T2");
        assertThat(store.steps("T2")).isEmpty();
        assertThat(rater.call(HttpMethod.GET, "/api/session", null)
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        var overview = new Browser(null).session(HttpMethod.GET, "/api/admin/overview", null);
        assertThat(find(overview.get("raters"), "id", "T2").get("status").asString())
                .isEqualTo("Withdrawn");
        assertThat(new Browser(null)
                        .call(HttpMethod.POST, "/api/admin/link", Map.of("rater", "T2"))
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
    }

    @Test
    void listsTheDeploymentsLegalDocumentsAndShowsItsOwn() throws Exception {
        var site = json.readTree(mvc.perform(request(HttpMethod.GET, "/api/site"))
                .andReturn()
                .getResponse()
                .getContentAsString());
        assertThat(site.get("contact").get("email").asString())
                .isEqualTo(loaded.study().contact().email());
        assertThat(site.get("legal")).isEqualTo(json.readTree("""
                        [{"id":"imprint","title":"Imprint","href":"https://example.org/imprint"},
                         {"id":"privacy","title":"Privacy","href":"/legal/privacy"}]"""));
        var privacy = json.readTree(mvc.perform(request(HttpMethod.GET, "/api/legal/privacy"))
                .andReturn()
                .getResponse()
                .getContentAsString());
        assertThat(privacy.get("markdown").asString()).startsWith("# Privacy");
        assertThat(mvc.perform(request(HttpMethod.GET, "/api/legal/imprint"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(404);
    }

    @Test
    void endsWithOnlyTheRatersAssignedBriefsInRatingOrder() throws Exception {
        var team = new Browser(null);
        var rater = new Browser("T1");
        assertThat(rater.consent().at("/step/kind").asString()).isEqualTo("onboarding");
        assertThat(status(team, "T1")).isEqualTo("Introduction");
        rater.session(HttpMethod.POST, "/api/step/submit", Map.of("step", "onboarding", "answers", Map.of()));
        assertThat(status(team, "T1")).isEqualTo("About you");
        var current = rater.complete(rater.session(HttpMethod.GET, "/api/session", null));
        current = rater.throughExercise(rater.throughExercise(current));
        assertThat(current.at("/step/kind").asString()).isEqualTo("exit");
        assertThat(status(team, "T1")).isEqualTo("Looking back");
        current = rater.complete(current);

        // T1 rates L1 then E1; M1 must never appear.
        assertThat(current.at("/step/kind").asString()).isEqualTo("briefs");
        assertThat(current.at("/step/key").asString()).isEqualTo("briefs");
        assertThat(status(team, "T1")).isEqualTo("Briefs");
        var briefs = current.at("/step/briefs");
        assertThat(briefs.valueStream()
                        .map(brief -> brief.get("number").asInt() + ":"
                                + brief.get("phase").asString() + ":"
                                + brief.get("rated").asBoolean()))
                .containsExactly("1:late:true", "2:early:true");
        for (var code : List.of("L1", "E1")) {
            var brief = loaded.exercises().get(code).get("brief").asString();
            assertThat(briefs.valueStream().map(entry -> entry.get("brief").asString()))
                    .contains(brief);
        }
        assertThat(briefs.valueStream().map(entry -> entry.get("brief").asString()))
                .doesNotContain(loaded.exercises().get("M1").get("brief").asString());
        assertThat(current.get("progress")
                        .valueStream()
                        .map(segment -> segment.get("label").asString()))
                .containsExactly(
                        "Consent", "Introduction", "About you", "Exercise 1", "Exercise 2", "Looking back", "Briefs");
        assertThat(current.at("/progress/6/state").asString()).isEqualTo("current");

        rater.session(
                HttpMethod.PUT,
                "/api/step/draft",
                Map.of("step", "briefs", "answers", Map.of("BR3", Map.of("text", "Brief 2 is vague."))));
        assertThat(rater.session(HttpMethod.GET, "/api/session", null)
                        .at("/step/draft/BR3/text")
                        .asString())
                .isEqualTo("Brief 2 is vague.");
        current = rater.complete(current);
        assertThat(current.at("/step/kind").asString()).isEqualTo("done");
        assertThat(raters.answersOf("T1", "briefs")).containsOnlyKeys("BR1", "BR2", "BR3");
        assertThat(status(team, "T1")).isEqualTo("Done");
        var overview = team.session(HttpMethod.GET, "/api/admin/overview", null);
        assertThat(find(overview.get("raters"), "id", "T1").at("/progress/done").asInt())
                .isEqualTo(3 + 4 * 2 + 2);
        var files = unzip(team.call(HttpMethod.GET, "/api/admin/export.zip?role=test", null)
                .getResponse()
                .getContentAsByteArray());
        assertThat(files.get("briefs.csv")).startsWith("rater_id,role,submitted_at,BR1,BR1_text,BR2,BR2_text,BR3\n");
        assertThat(files.get("briefs.csv").strip().split("\n")).hasSize(2);
        assertThat(files.get("CODEBOOK.md")).contains("## briefs.csv\n\nOne row per rater: feedback on the briefs.");
    }

    @Test
    void ratesAnExerciseAssignedAfterLookingBackBeforeTheBriefs() throws Exception {
        var team = new Browser(null);
        var rater = new Browser("T1");
        var current = rater.throughExercise(rater.throughExercise(rater.throughBackground()));
        current = rater.complete(current);
        assertThat(current.at("/step/kind").asString()).isEqualTo("briefs");

        // On the briefs, the rater has answered looking back, so the new exercise comes after it.
        team.session(
                HttpMethod.POST,
                "/api/admin/assign",
                with(Map.of("rater", "T1", "kind", "additional", "exercises", List.of("M1")), "replaces", null));
        var assigned = team.session(HttpMethod.GET, "/api/admin/overview", null)
                .get("changes")
                .get(0);
        assertThat(assigned.get("action").asString()).isEqualTo("exercises assigned");
        assertThat(assigned.get("detail").asString()).isEqualTo("M1 to T1 as additional, after “Looking back”");

        current = rater.session(HttpMethod.GET, "/api/session", null);
        assertThat(current.at("/step/key").asString()).isEqualTo("exercise-3-A");
        assertThat(current.at("/progress/6/label").asString()).isEqualTo("Looking back");
        assertThat(current.at("/progress/6/state").asString()).isEqualTo("done");
        assertThat(current.at("/rater").propertyNames()).containsExactly("id");
        assertThat(rater.throughExercise(current).at("/step/kind").asString()).isEqualTo("briefs");
        var briefs = Map.of(
                "BR1", Map.of("value", "no", "text", "Brief 2 is vague."),
                "BR2", Map.of("value", "no", "text", "Recursion comes too early."),
                "BR3", Map.of("text", "Brief 3 is good."));
        current = rater.session(HttpMethod.POST, "/api/step/submit", Map.of("step", "briefs", "answers", briefs));
        assertThat(current.at("/step/kind").asString()).isEqualTo("done");

        // The free text of both closing steps reaches the dashboard, each under its section's title.
        var instrument = loaded.instrument();
        assertThat(team.session(HttpMethod.GET, "/api/admin/overview", null)
                        .get("feedback")
                        .valueStream()
                        .map(comment -> comment.get("section").asString() + " "
                                + comment.get("item").asString() + ": "
                                + comment.get("text").asString()))
                .containsExactly(
                        instrument.briefs().title() + " BR1: Brief 2 is vague.",
                        instrument.briefs().title() + " BR2: Recursion comes too early.",
                        instrument.briefs().title() + " BR3: Brief 3 is good.",
                        instrument.exit().title() + " X8: A reason.");
    }

    private String status(Browser team, String rater) throws Exception {
        var overview = team.session(HttpMethod.GET, "/api/admin/overview", null);
        return find(overview.get("raters"), "id", rater).get("status").asString();
    }

    @Test
    void exportsTidyTablesWithOneRowPerRatingAndACodebook() throws Exception {
        var rater = new Browser("T1");
        var current = rater.throughBackground();
        for (var part : List.of("A", "B", "C", "D")) {
            current = rater.complete(rater.session(
                    HttpMethod.POST,
                    "/api/step/open",
                    Map.of("step", current.at("/step/key").asString())));
        }
        var team = new Browser(null);
        var archive = team.call(HttpMethod.GET, "/api/admin/export.zip?role=test", null)
                .getResponse()
                .getContentAsByteArray();
        var files = unzip(archive);
        assertThat(files.keySet())
                .containsExactlyInAnyOrder(
                        "CODEBOOK.md",
                        "background.csv",
                        "briefs.csv",
                        "changes.csv",
                        "data.json",
                        "events.csv",
                        "exit.csv",
                        "raters.csv",
                        "ratings.csv");
        var ratings = files.get("ratings.csv").strip().split("\n");
        assertThat(ratings[0])
                .contains("rater_id,role,exercise_code,exercise_id,exercise_sha256,")
                .contains(",CL1,CL1_text,")
                .contains(",DF1,DF1_choice,DF1_text,");
        assertThat(ratings).anySatisfy(row -> assertThat(row).startsWith("T1,test,L1,"));
        assertThat(files.get("CODEBOOK.md")).contains("| `RD2` |");
    }

    @Nested
    class FindingsPresentationProvenance {
        private JsonNode beforePartD(Browser browser) throws Exception {
            var current = browser.throughBackground();
            for (var part : List.of("A", "B", "C")) {
                assertThat(current.at("/step/part").asString()).isEqualTo(part);
                current = browser.complete(browser.session(
                        HttpMethod.POST,
                        "/api/step/open",
                        Map.of("step", current.at("/step/key").asString())));
            }
            assertThat(current.at("/step/part").asString()).isEqualTo("D");
            return current;
        }

        @Test
        void oldClientsRecordUnversionedExposureAndSubmission() throws Exception {
            var browser = new Browser("T1");
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            assertThat(store.step("T1", key)).isEmpty();
            current = browser.session(HttpMethod.POST, "/api/step/open", Map.of("step", key));
            browser.complete(current);
            var stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("legacy-unversioned");
            assertThat(stored.findingsPresentationAtSubmit()).isEqualTo("legacy-unversioned");
            assertThat(stored.instrumentVersion()).isEqualTo("4");
        }

        @Test
        void recordsANewClientAndExportsThePresentationWithoutInventingLegacyExposure() throws Exception {
            var browser = new Browser("T1");
            browser.presentation = "categories-v1";
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            browser.session(HttpMethod.GET, "/api/session", null);
            assertThat(store.step("T1", key)).isEmpty();
            current = browser.session(HttpMethod.POST, "/api/step/open", Map.of("step", key));
            assertThat(store.step("T1", key).orElseThrow().findingsPresentations())
                    .containsExactly("categories-v1");
            browser.session(HttpMethod.GET, "/api/session", null);
            browser.session(HttpMethod.GET, "/api/session", null);
            browser.complete(current);
            var stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("categories-v1");
            assertThat(stored.findingsPresentationAtSubmit()).isEqualTo("categories-v1");
            var team = new Browser(null);
            var files = unzip(team.call(HttpMethod.GET, "/api/admin/export.zip?role=test", null)
                    .getResponse()
                    .getContentAsByteArray());
            var row = json.readTree(files.get("data.json")).at("/tables/ratings/0");
            assertThat(row.get("findings_presentations").asString()).isEqualTo("categories-v1");
            assertThat(row.get("findings_presentation_at_submit").asString()).isEqualTo("categories-v1");
            assertThat(row.get("findings_presentation_mixed").asBoolean()).isFalse();
            assertThat(files.get("ratings.csv"))
                    .contains("findings_presentations")
                    .contains("categories-v1");
            assertThat(files.get("CODEBOOK.md"))
                    .contains("legacy-unversioned")
                    .contains("does not reconstruct an exact past version");
            var personalCsv = browser.call(HttpMethod.GET, "/api/me/answers.csv", null)
                    .getResponse()
                    .getContentAsString();
            assertThat(personalCsv).contains("findings_presentations").contains("categories-v1");
            var personal = json.readTree(browser.call(HttpMethod.GET, "/api/me/answers.json", null)
                    .getResponse()
                    .getContentAsString());
            assertThat(find(personal.get("steps"), "step", key)
                            .get("findings_presentations")
                            .get(0)
                            .asString())
                    .isEqualTo("categories-v1");
        }

        @Test
        void aLegacyPartResumedAfterReloadIsMixedBeforeSubmission() throws Exception {
            var browser = new Browser("T1");
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            current = browser.session(HttpMethod.POST, "/api/step/open", Map.of("step", key));
            var openedAt = store.step("T1", key).orElseThrow().openedAt();
            browser.presentation = "categories-v1";
            browser.session(HttpMethod.GET, "/api/session", null);
            browser.call(HttpMethod.PUT, "/api/step/draft", Map.of("step", key, "answers", Map.of()));
            var stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("legacy-unversioned", "categories-v1");
            assertThat(stored.openedAt()).isEqualTo(openedAt);
            assertThat(stored.findingsPresentationAtSubmit()).isNull();
            browser.complete(current);
            stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("legacy-unversioned", "categories-v1");
            assertThat(stored.findingsPresentationAtSubmit()).isEqualTo("categories-v1");
            var files = unzip(new Browser(null)
                    .call(HttpMethod.GET, "/api/admin/export.zip?role=test", null)
                    .getResponse()
                    .getContentAsByteArray());
            assertThat(json.readTree(files.get("data.json"))
                            .at("/tables/ratings/0/findings_presentation_mixed")
                            .asBoolean())
                    .isTrue();
        }

        @Test
        void submittingFromAnOlderTabRecordsTheSubmissionHeaderAsWell() throws Exception {
            var browser = new Browser("T1");
            browser.presentation = "categories-v1";
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            current = browser.session(HttpMethod.POST, "/api/step/open", Map.of("step", key));
            browser.presentation = null;
            browser.complete(current);
            var stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("categories-v1", "legacy-unversioned");
            assertThat(stored.findingsPresentationAtSubmit()).isEqualTo("legacy-unversioned");
        }

        @Test
        void aDraftFromAnotherPresentationRecordsExposureWithoutASessionReload() throws Exception {
            var browser = new Browser("T1");
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            browser.session(HttpMethod.POST, "/api/step/open", Map.of("step", key));
            browser.presentation = "categories-v1";
            assertThat(browser.call(HttpMethod.PUT, "/api/step/draft", Map.of("step", key, "answers", Map.of()))
                            .getResponse()
                            .getStatus())
                    .isEqualTo(200);
            var stored = store.step("T1", key).orElseThrow();
            assertThat(stored.findingsPresentations()).containsExactly("legacy-unversioned", "categories-v1");
            assertThat(stored.findingsPresentationAtSubmit()).isNull();
        }

        @Test
        void unknownPresentationIdsDoNotChangeStoredProvenance() throws Exception {
            var browser = new Browser("T1");
            var current = beforePartD(browser);
            var key = current.at("/step/key").asString();
            browser.presentation = "invented-quality-score";
            assertThat(browser.call(HttpMethod.GET, "/api/session", null)
                            .getResponse()
                            .getStatus())
                    .isEqualTo(400);
            assertThat(browser.call(HttpMethod.POST, "/api/step/open", Map.of("step", key))
                            .getResponse()
                            .getStatus())
                    .isEqualTo(400);
            assertThat(store.step("T1", key)).isEmpty();
        }

        @Test
        void migrationPreservesExistingAnswersDraftsAndUncertainHistoricalExposure() throws Exception {
            database.sql(
                            "CREATE TABLE presentation_migration_step (rater_id text, step text, opened_at timestamptz, submitted_at timestamptz, answers json, draft json)")
                    .update();
            try {
                database.sql(
                                "INSERT INTO presentation_migration_step VALUES ('old','exercise-1-D',now(),now(),'{\"AF1\":{\"value\":\"no\"}}',NULL), ('draft','exercise-1-D',now(),NULL,NULL,'{\"REM\":{\"text\":\"saved\"}}'), ('unopened','exercise-1-D',NULL,NULL,NULL,NULL), ('other','exercise-1-C',now(),now(),'{}',NULL)")
                        .update();
                var changelog = new String(
                        getClass().getResourceAsStream("/db/changelog.sql").readAllBytes(), StandardCharsets.UTF_8);
                var migration = changelog.substring(changelog.indexOf("--changeset survey:3"));
                migration = migration
                        .lines()
                        .filter(line -> !line.startsWith("--"))
                        .collect(java.util.stream.Collectors.joining("\n"))
                        .replace("ALTER TABLE step ", "ALTER TABLE presentation_migration_step ")
                        .replace("UPDATE step SET", "UPDATE presentation_migration_step SET");
                for (var statement : migration.split(";"))
                    if (!statement.isBlank()) database.sql(statement).update();
                var rows = database.sql(
                                "SELECT rater_id, findings_presentations::text AS seen, findings_presentation_at_submit AS submitted, answers::text, draft::text FROM presentation_migration_step ORDER BY rater_id")
                        .query()
                        .listOfRows();
                assertThat(rows)
                        .anySatisfy(row -> {
                            assertThat(row.get("rater_id")).isEqualTo("old");
                            assertThat(row.get("seen")).isEqualTo("{legacy-unversioned}");
                            assertThat(row.get("submitted")).isEqualTo("legacy-unversioned");
                            assertThat(row.get("answers")).isEqualTo("{\"AF1\":{\"value\":\"no\"}}");
                        })
                        .anySatisfy(row -> {
                            assertThat(row.get("rater_id")).isEqualTo("draft");
                            assertThat(row.get("seen")).isEqualTo("{legacy-unversioned}");
                            assertThat(row.get("submitted")).isNull();
                            assertThat(row.get("draft")).isEqualTo("{\"REM\":{\"text\":\"saved\"}}");
                        })
                        .anySatisfy(row -> {
                            assertThat(row.get("rater_id")).isEqualTo("unopened");
                            assertThat(row.get("seen")).isEqualTo("{}");
                        })
                        .anySatisfy(row -> {
                            assertThat(row.get("rater_id")).isEqualTo("other");
                            assertThat(row.get("seen")).isEqualTo("{}");
                        });
            } finally {
                database.sql("DROP TABLE presentation_migration_step").update();
            }
        }
    }

    private static Map<String, Object> with(Map<String, Object> base, Object... pairs) {
        var map = new LinkedHashMap<>(base);
        for (int index = 0; index < pairs.length; index += 2) {
            map.put((String) pairs[index], pairs[index + 1]);
        }
        return map;
    }

    private static JsonNode find(JsonNode list, String field, String value) {
        for (var entry : list) {
            if (entry.get(field).asString().equals(value)) {
                return entry;
            }
        }
        throw new AssertionError("no entry with " + field + " " + value);
    }

    private static Map<String, String> unzip(byte[] archive) throws IOException {
        var files = new TreeMap<String, String>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                files.put(entry.getName(), new String(zip.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        return files;
    }
}
