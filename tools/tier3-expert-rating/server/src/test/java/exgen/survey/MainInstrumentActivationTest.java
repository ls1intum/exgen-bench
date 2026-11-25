package exgen.survey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.SurveyStore.MainInstrumentReplacement;
import exgen.survey.study.Instrument;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Manifest;
import exgen.survey.study.Study;
import exgen.survey.study.StudyLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Replacing the active main instrument (V6 by V7) before the main study starts: an exact,
 * audited compare-and-set that refuses any other change and any main or reserve activity. Its own
 * Spring context and PostgreSQL, so it never shares state with {@link ServerTest}.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
            "survey.study=src/test/resources/study",
            "survey.web=src/test/resources/web",
            "survey.secure-cookies=false",
            "survey.legal.imprint=https://example.org/imprint",
            "survey.legal.privacy=src/test/resources/legal/privacy.md",
            // A distinct context: this class mutates the frozen main instrument.
            "survey.test.context=main-instrument-activation"
        })
@Import(PostgresTestConfiguration.class)
class MainInstrumentActivationTest {
    static final Path INSTRUMENTS = Path.of("../instruments");

    @Autowired
    SurveyStore store;

    @Autowired
    LoadedStudy loaded;

    @Autowired
    JdbcClient database;

    @Autowired
    PostgreSQLContainer postgres;

    static Instrument six;
    static Instrument seven;

    static Instrument seven() {
        if (seven == null) {
            seven = StudyLoader.loadInstrument(INSTRUMENTS.resolve("7.yaml"));
        }
        return seven;
    }

    static Instrument six() {
        if (six == null) {
            six = StudyLoader.loadInstrument(INSTRUMENTS.resolve("6.yaml"));
        }
        return six;
    }

    @BeforeEach
    void reset() {
        database.sql("TRUNCATE step, event, link, change_log").update();
        database.sql("DELETE FROM assignment WHERE kind <> 'planned'").update();
        database.sql("UPDATE assignment SET removed_at = NULL").update();
        database.sql("DELETE FROM assignment WHERE rater_id IN (SELECT id FROM rater WHERE added_at IS NOT NULL)")
                .update();
        database.sql("DELETE FROM rater WHERE added_at IS NOT NULL").update();
        database.sql("DELETE FROM frozen WHERE key = 'main_instrument'").update();
        database.sql("UPDATE rater SET declined_at = NULL, withdrawn_at = NULL").update();
    }

    private LoadedStudy with(Instrument main, String summary, Consumer<List<Study.Rater>> plan) {
        var study = loaded.study();
        var raters = new ArrayList<>(study.raters());
        plan.accept(raters);
        return new LoadedStudy(
                new Study(
                        study.schemaVersion(),
                        study.id(),
                        study.title(),
                        study.instrumentVersion(),
                        main == null ? null : main.version(),
                        summary,
                        study.contact(),
                        study.deadlines(),
                        study.consent(),
                        study.ratingsPerExercise(),
                        study.exercises(),
                        List.copyOf(raters)),
                loaded.instrument(),
                main,
                loaded.manifest(),
                loaded.exercises(),
                loaded.idOf());
    }

    private LoadedStudy with(Instrument main) {
        return with(main, null, raters -> {});
    }

    private String active() {
        return database.sql("SELECT value FROM frozen WHERE key = 'main_instrument'")
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private List<String> log() {
        return store.changes().stream()
                .map(change -> change.action() + ": " + change.detail())
                .toList();
    }

    /** V6 active, with a pilot that already answered under the base instrument. */
    private String activateSixAfterPilot() {
        store.addRater("P1", Study.Role.PILOT, null);
        store.open("P1", "consent");
        store.saveDraft("P1", "background", "{}");
        store.synchronize(with(six()));
        assertThat(active()).isEqualTo(SurveyStore.mainInstrumentFingerprint(with(six())));
        return active();
    }

    private void assertUnchanged(String fingerprint) {
        assertThat(active()).isEqualTo(fingerprint);
        assertThat(log()).noneMatch(line -> line.startsWith("main instrument replaced"));
    }

    @Test
    void firstActivationNeedsNoAuthorizationAndStillRefusesStartedMainRaters() {
        store.synchronize(with(six()));
        assertThat(log())
                .containsExactly("main instrument activated: Main and reserve raters use instrument 6;"
                        + " pilot and test raters use instrument "
                        + loaded.instrument().version() + ".");

        reset();
        store.open("R2", "consent");
        assertThatThrownBy(() -> store.synchronize(with(six())))
                .hasMessageContaining("main or reserve raters have already started (R2)");
        assertThat(active()).isNull();
    }

    @Test
    void replacesSixBySevenOnceWithTheExpectedFingerprintAndAuditsIt() {
        var sixPrint = activateSixAfterPilot();
        store.issueLink("R1");
        var target = with(seven());
        var sevenPrint = SurveyStore.mainInstrumentFingerprint(target);
        var authorization = new MainInstrumentReplacement(sixPrint, "7");

        store.synchronize(target, authorization);

        assertThat(active()).isEqualTo(sevenPrint).isNotEqualTo(sixPrint);
        assertThat(log())
                .filteredOn(line -> line.startsWith("main instrument replaced"))
                .singleElement()
                .asString()
                .contains("instrument 7 (fingerprint " + sevenPrint + ")")
                .contains("with fingerprint " + sixPrint)
                .contains("Pilot and test raters keep instrument "
                        + loaded.instrument().version())
                .contains("1 main or reserve raters hold a link");
        // The pilot's records and the base instrument stay as they were.
        assertThat(store.steps("P1")).hasSize(2);
        assertThat(with(seven()).instrumentFor(Study.Role.PILOT)).isSameAs(loaded.instrument());

        // Restarts with the authorization still set, or without it, keep V7 and log nothing more.
        store.synchronize(target, authorization);
        store.synchronize(target, null);
        assertThat(log()).filteredOn(line -> line.startsWith("main instrument")).hasSize(2);

        // V6 can no longer start against this database, with or without the stale authorization.
        assertThatThrownBy(() -> store.synchronize(with(six()), null))
                .hasMessageContaining("frozen main instrument changed");
        assertThatThrownBy(() -> store.synchronize(with(six()), new MainInstrumentReplacement(sixPrint, "6")))
                .hasMessageContaining("not the expected");
        assertThat(active()).isEqualTo(sevenPrint);
    }

    @Test
    void aChangedConsentSummaryIsPartOfTheReplacedContract() {
        var sixPrint = activateSixAfterPilot();
        var target = with(seven(), "Main raters need about 85 minutes.", raters -> {});
        store.synchronize(target, new MainInstrumentReplacement(sixPrint, "7"));
        assertThat(active()).isEqualTo(SurveyStore.mainInstrumentFingerprint(target));
        assertThatThrownBy(() -> store.synchronize(with(seven()), null))
                .hasMessageContaining("frozen main instrument changed");
    }

    @Test
    void refusesWithoutTheExactAuthorization() {
        var sixPrint = activateSixAfterPilot();
        var target = with(seven());

        assertThatThrownBy(() -> store.synchronize(target, null))
                .hasMessageContaining("frozen main instrument changed")
                .hasMessageContaining("SURVEY_ACTIVATION_FROM");
        var wrong = "0".repeat(64);
        assertThatThrownBy(() -> store.synchronize(target, new MainInstrumentReplacement(wrong, "7")))
                .hasMessageContaining("the active main instrument is " + sixPrint + ", not the expected " + wrong);
        assertThatThrownBy(() -> store.synchronize(target, new MainInstrumentReplacement(sixPrint, "8")))
                .hasMessageContaining(
                        "replaces the main instrument with version 8, but study.yaml names main instrument 7");
        // The deployment forgot to update study.yaml: the image must not start on V6 while V7 was intended.
        assertThatThrownBy(() -> store.synchronize(with(six()), new MainInstrumentReplacement(sixPrint, "7")))
                .hasMessageContaining("but study.yaml names main instrument 6");
        assertThatThrownBy(() -> store.synchronize(with(null), new MainInstrumentReplacement(sixPrint, "7")))
                .hasMessageContaining("but study.yaml names no main instrument");
        assertUnchanged(sixPrint);
    }

    @Test
    void refusesToReplaceWhenNoMainInstrumentIsActive() {
        assertThatThrownBy(() -> store.synchronize(with(seven()), new MainInstrumentReplacement("a".repeat(64), "7")))
                .hasMessageContaining("none is active");
        assertThat(active()).isNull();
        assertThat(log()).isEmpty();
    }

    @Test
    void refusesMalformedAuthorizations() {
        assertThatThrownBy(() -> new MainInstrumentReplacement("ABC", "7")).hasMessageContaining("fingerprint");
        assertThatThrownBy(() -> new MainInstrumentReplacement("A".repeat(64), "7"))
                .hasMessageContaining("fingerprint");
        assertThatThrownBy(() -> new MainInstrumentReplacement("a".repeat(64), "v7"))
                .hasMessageContaining("instrument version");
        assertThatThrownBy(() -> new MainInstrumentReplacement("a".repeat(64), null))
                .hasMessageContaining("instrument version");
    }

    /** Every trace a main or reserve rater leaves blocks the replacement, and nothing is replaced. */
    @Test
    void refusesAfterAnyMainOrReserveActivity() {
        Map<String, Runnable> activities = Map.of(
                "R1 opened", () -> store.open("R1", "consent"),
                "R1 drafted", () -> store.saveDraft("R1", "background", "{}"),
                "R1 submitted", () -> database.sql("""
                                INSERT INTO step (rater_id, step, opened_at, answers, instrument_version, submitted_at)
                                VALUES ('R1', 'consent', now(), CAST('{}' AS json), '6', now())""").update(),
                "R1 declined", () -> store.decline("R1"),
                "R1 withdrew", () -> store.withdraw("R1"),
                "R1 viewed", () -> store.logEvents("R1", "consent", List.of(new SurveyStore.ViewEvent("tab", "x"))),
                "R2 opened", () -> store.open("R2", "consent"),
                "R2 declined", () -> store.decline("R2"));
        for (var activity : activities.entrySet()) {
            reset();
            var sixPrint = activateSixAfterPilot();
            activity.getValue().run();
            var rater = activity.getKey().substring(0, 2);
            assertThatThrownBy(
                            () -> store.synchronize(with(seven()), new MainInstrumentReplacement(sixPrint, "7")),
                            activity.getKey())
                    .hasMessageContaining("main or reserve raters have already started (" + rater + ")");
            assertUnchanged(sixPrint);
        }
    }

    @Test
    void pilotAndTestActivityDoNotBlockTheReplacement() {
        var sixPrint = activateSixAfterPilot();
        store.decline("P1");
        store.open("T1", "consent");
        store.logEvents("T1", "consent", List.of(new SurveyStore.ViewEvent("tab", "x")));
        store.synchronize(with(seven()), new MainInstrumentReplacement(sixPrint, "7"));
        assertThat(active()).isEqualTo(SurveyStore.mainInstrumentFingerprint(with(seven())));
    }

    /** Anything else the database froze still refuses, and rolls the replacement and its audit back. */
    @Test
    void anyOtherFrozenChangeRollsTheReplacementBack() {
        var sixPrint = activateSixAfterPilot();
        var authorization = new MainInstrumentReplacement(sixPrint, "7");

        var replan = with(
                seven(),
                null,
                raters -> raters.replaceAll(rater -> rater.id().equals("R1")
                        ? new Study.Rater("R1", Study.Role.MAIN, List.of("L1", "M1", "E1"))
                        : rater));
        assertThatThrownBy(() -> store.synchronize(replan, authorization))
                .hasMessageContaining("the plan of R1 changed");
        assertUnchanged(sixPrint);

        var manifest = loaded.manifest();
        var rebuilt = new Manifest(
                manifest.schemaVersion(),
                manifest.studyId(),
                manifest.exercises().stream()
                        .map(entry -> entry == manifest.exercises().getFirst()
                                ? new Manifest.Entry(
                                        entry.code(), entry.id(), entry.phase(), "f".repeat(64), entry.source())
                                : entry)
                        .toList());
        var target = with(seven());
        var rebuiltStudy = new LoadedStudy(
                target.study(), target.instrument(), seven(), rebuilt, target.exercises(), target.idOf());
        assertThatThrownBy(() -> store.synchronize(rebuiltStudy, authorization)).hasMessageContaining("was rebuilt");
        assertUnchanged(sixPrint);

        var otherBase = new LoadedStudy(
                new Study(
                        target.study().schemaVersion(),
                        target.study().id(),
                        target.study().title(),
                        "6",
                        "7",
                        null,
                        target.study().contact(),
                        target.study().deadlines(),
                        target.study().consent(),
                        target.study().ratingsPerExercise(),
                        target.study().exercises(),
                        target.study().raters()),
                six(),
                seven(),
                target.manifest(),
                target.exercises(),
                target.idOf());
        assertThatThrownBy(() -> store.synchronize(otherBase, authorization))
                .hasMessageContaining("the instrument changed after this database was created");
        assertUnchanged(sixPrint);
    }

    /**
     * The deployment's environment reaches the server: SURVEY_ACTIVATION_* on a study that does not
     * name the target stops startup, and a half-set authorization is refused.
     */
    @Test
    void theServerDoesNotStartWithAnAuthorizationForAnotherContract() {
        var sixPrint = activateSixAfterPilot();
        assertThatThrownBy(() -> start(Map.of("SURVEY_ACTIVATION_FROM", sixPrint, "SURVEY_ACTIVATION_TO", "7")))
                .rootCause()
                .hasMessageContaining("but study.yaml names no main instrument");
        assertThatThrownBy(() -> start(Map.of("SURVEY_ACTIVATION_FROM", sixPrint)))
                .rootCause()
                .hasMessageContaining("set both SURVEY_ACTIVATION_FROM and SURVEY_ACTIVATION_TO");
        assertUnchanged(sixPrint);
    }

    private void start(Map<String, Object> environment) {
        var application = new SpringApplication(SurveyApplication.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        var spring = new StandardEnvironment();
        spring.getPropertySources()
                .replace(
                        StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        new SystemEnvironmentPropertySource(
                                StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, environment));
        application.setEnvironment(spring);
        // Command-line arguments, which take precedence over application.yml.
        application
                .run(
                        "--spring.datasource.url=" + postgres.getJdbcUrl(),
                        "--spring.datasource.username=" + postgres.getUsername(),
                        "--spring.datasource.password=" + postgres.getPassword(),
                        "--survey.study=src/test/resources/study",
                        "--survey.web=src/test/resources/web",
                        "--survey.legal.imprint=https://example.org/imprint",
                        "--survey.legal.privacy=src/test/resources/legal/privacy.md",
                        "--logging.level.root=warn")
                .close();
    }
}
