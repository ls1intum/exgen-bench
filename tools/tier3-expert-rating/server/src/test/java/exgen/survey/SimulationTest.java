package exgen.survey;

import static org.assertj.core.api.Assertions.assertThat;

import exgen.survey.export.ExportArchive;
import exgen.survey.rating.Readiness;
import exgen.survey.rating.Step.Kind;
import exgen.survey.rating.SurveyStore;
import exgen.survey.study.Answer;
import exgen.survey.study.AnswerRules;
import exgen.survey.study.Instrument;
import exgen.survey.study.Instrument.ChoiceItem;
import exgen.survey.study.Instrument.Item;
import exgen.survey.study.Instrument.MultiItem;
import exgen.survey.study.Instrument.TextItem;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Manifest;
import exgen.survey.study.Study;
import exgen.survey.study.StudyLoader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.function.IntPredicate;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import tools.jackson.databind.json.JsonMapper;

/**
 * A simulated run of the study design's plan, for testing the analysis before any rater answers:
 * eight main raters rate twelve exercises, one of them stops after the first exercise and a reserve
 * rater takes over the rest, and the other reserve rater breaks ties. Answers are seeded and follow a
 * simple model, in which an exercise has a quality and a rater a severity, so the statistics have
 * something to find. Nothing here is evidence about real exercises.
 *
 * <p>The export must equal {@code analysis/example/data.json}, which the analysis report is built
 * from: the simulation and the analysis are pinned to their committed output. Run with
 * {@code -Dsurvey.example.write=true} ({@code bun run survey:example}) to rewrite it.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
            "spring.main.allow-bean-definition-overriding=true",
            "survey.study=../demo",
            "survey.web=src/test/resources/web"
        })
@Import({PostgresTestConfiguration.class, SimulationTest.Simulated.class})
class SimulationTest {
    static final Path EXAMPLE = Path.of("../analysis/example/data.json");
    static final long SEED = 20261026L;

    /** The plan of the study design (Section 4). */
    static final Map<String, List<String>> PLAN = plan();

    static final String DROPOUT = "R8";
    static final String BACKUP = "R10";
    static final String TIE_BREAKER = "R9";

    private static Map<String, List<String>> plan() {
        var plan = new LinkedHashMap<String, List<String>>();
        plan.put("R1", List.of("E1", "M1", "L1"));
        plan.put("R2", List.of("M2", "E1", "L2"));
        plan.put("R3", List.of("M1", "L3", "E2"));
        plan.put("R4", List.of("E2", "L4", "M2"));
        plan.put("R5", List.of("L1", "E3", "M3"));
        plan.put("R6", List.of("L2", "M4", "E3"));
        plan.put("R7", List.of("E4", "M3", "L3"));
        plan.put("R8", List.of("L4", "E4", "M4"));
        return plan;
    }

    /** Simulated time, starting when the study would. */
    static final class Clock implements InstantSource {
        long millis = Instant.parse("2026-11-02T09:00:00Z").toEpochMilli();

        @Override
        public Instant instant() {
            return Instant.ofEpochMilli(millis);
        }

        void advance(double minutes) {
            millis += Math.round(minutes * 60_000);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Simulated {
        @Bean
        Clock clock() {
            return new Clock();
        }

        @Bean
        LoadedStudy study(SurveyProperties properties, SurveyStore store) {
            var loaded = simulatedStudy(StudyLoader.loadInstrument(properties.instrumentPath()));
            store.synchronize(loaded);
            return loaded;
        }
    }

    static LoadedStudy simulatedStudy(Instrument instrument) {
        var codes = Stream.of("E", "M", "L")
                .flatMap(phase -> Stream.of(1, 2, 3, 4).map(index -> phase + index))
                .toList();
        var phases = Map.of('E', "early", 'M', "middle", 'L', "late");
        var raters = new ArrayList<Study.Rater>();
        PLAN.forEach((id, exercises) -> raters.add(new Study.Rater(id, Study.Role.MAIN, exercises)));
        raters.add(new Study.Rater(TIE_BREAKER, Study.Role.RESERVE, List.of()));
        raters.add(new Study.Rater(BACKUP, Study.Role.RESERVE, List.of()));
        var reference = new LinkedHashMap<String, Study.Reference>();
        reference.put("CL1", new Study.Reference(new Answer("yes", null, null, null), "Simulated."));
        reference.put("SO1", new Study.Reference(new Answer("yes", null, null, null), "Simulated."));
        reference.put("FB1", new Study.Reference(new Answer("yes", null, null, null), "Simulated."));
        reference.put("RD1", new Study.Reference(new Answer(4, null, null, null), "Simulated."));
        var study = new Study(
                "1",
                "expert-rating-simulation",
                "Expert study, simulated answers",
                "2",
                new Study.Contact("Study team", "study-team@example.org"),
                Map.of(),
                new Study.Consent(
                        "Simulated raters.",
                        "Simulated raters.",
                        List.of(new Study.Statement("participate", "Simulated consent."))),
                2,
                codes.stream()
                        .map(code -> new Study.ExerciseEntry(code, phases.get(code.charAt(0))))
                        .toList(),
                new Study.Calibration("CAL", "early", reference),
                raters);
        var all = Stream.concat(codes.stream(), Stream.of("CAL")).toList();
        var entries = new ArrayList<Manifest.Entry>();
        var idOf = new LinkedHashMap<String, String>();
        for (int index = 0; index < all.size(); index++) {
            var code = all.get(index);
            var id = "S%03d".formatted(index);
            entries.add(new Manifest.Entry(
                    code,
                    id,
                    code.equals("CAL") ? "early" : study.exercises().get(index).phase(),
                    StudyLoader.sha256(("simulated " + code).getBytes(StandardCharsets.UTF_8))));
            idOf.put(code, id);
        }
        return new LoadedStudy(study, instrument, new Manifest("1", study.id(), entries), Map.of(), idOf);
    }

    /** Mulberry32: a small seeded generator, so the same seed gives the same answers. */
    static final class Random {
        private int state;

        Random(long seed) {
            state = (int) seed;
        }

        double uniform() {
            state += 0x6d2b79f5;
            int t = state;
            t = (t ^ (t >>> 15)) * (t | 1);
            t ^= t + (t ^ (t >>> 7)) * (t | 61);
            return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
        }

        double normal() {
            var radius = StrictMath.sqrt(-2 * StrictMath.log(1 - uniform()));
            return radius * StrictMath.cos(2 * Math.PI * uniform());
        }

        <T> T pick(List<T> values) {
            return values.get((int) Math.floor(uniform() * values.size()));
        }
    }

    @Autowired
    LoadedStudy loaded;

    @Autowired
    SurveyStore store;

    @Autowired
    Clock clock;

    @Autowired
    JsonMapper json;

    @Test
    void reproducesTheCommittedExampleExport() throws IOException {
        var data = simulate();
        if (Boolean.getBoolean("survey.example.write")) {
            Files.writeString(EXAMPLE, data);
        }
        assertThat(data)
                .as("analysis/example/data.json differs from the simulation; run bun run survey:example")
                .isEqualTo(Files.readString(EXAMPLE));
    }

    private String simulate() {
        var random = new Random(SEED);
        var instrument = loaded.instrument();
        var codes = new ArrayList<>(loaded.study().exercises().stream()
                .map(Study.ExerciseEntry::code)
                .toList());
        codes.add(loaded.study().calibration().code());
        // The model: an exercise has a quality, a rater a severity; both shift every judgement.
        var quality = new LinkedHashMap<String, Double>();
        codes.forEach(code -> quality.put(code, random.normal()));
        var severity = new LinkedHashMap<String, Double>();
        loaded.study().raters().forEach(rater -> severity.put(rater.id(), 0.5 * random.normal()));
        var budget =
                Map.of(Instrument.PartId.A, 5, Instrument.PartId.B, 7, Instrument.PartId.C, 3, Instrument.PartId.D, 3);
        var rd1 = new LinkedHashMap<String, Long>();
        var rd2 = new LinkedHashMap<String, Long>();

        Function<Item, Object> none = item -> null;
        var simulation = new Object() {
            Answer answer(Item item, Object value) {
                if (item instanceof TextItem) {
                    return new Answer(null, null, null, "Simulated answer.");
                }
                var values = value instanceof List<?> list ? list : List.of(value);
                var options = item instanceof ChoiceItem choice ? choice.options() : ((MultiItem) item).options();
                var detail = options.stream()
                        .filter(option -> values.contains(option.value()))
                        .map(Instrument.Option::detail)
                        .filter(Objects::nonNull)
                        .findFirst()
                        .orElse(null);
                @SuppressWarnings("unchecked")
                var multiValues = item instanceof MultiItem ? (List<String>) values : null;
                var choice = detail != null && detail.choices() != null
                        ? random.pick(detail.choices()).value()
                        : null;
                return new Answer(
                        item instanceof MultiItem ? null : value,
                        multiValues,
                        choice,
                        detail == null ? null : "Simulated reason.");
            }

            /** Answers for one section: the model's values where it has one, else a random option. */
            Map<String, Answer> section(List<Item> items, Function<Item, Object> model) {
                var answers = new LinkedHashMap<String, Answer>();
                for (var item : items) {
                    switch (item) {
                        case TextItem text -> answers.put(text.id(), answer(text, null));
                        case MultiItem multi -> {
                            var option = random.pick(multi.options());
                            answers.put(multi.id(), answer(multi, List.of(String.valueOf(option.value()))));
                        }
                        case ChoiceItem choice -> {
                            var value = model.apply(choice);
                            answers.put(
                                    choice.id(),
                                    answer(
                                            choice,
                                            value != null
                                                    ? value
                                                    : random.pick(choice.options())
                                                            .value()));
                        }
                    }
                }
                var issues = AnswerRules.issues(items, answers);
                assertThat(issues).as("simulated answers").isEmpty();
                return AnswerRules.normalize(items, answers);
            }

            long readiness(String code, String rater) {
                return Math.min(
                        5,
                        Math.max(
                                1,
                                Math.round(
                                        3.3 + 0.9 * quality.get(code) - severity.get(rater) + 0.5 * random.normal())));
            }

            /** Answer every step a rater can reach, stopping after {@code stopAfter} exercises when given. */
            void rate(String raterId, IntPredicate stop) {
                for (; ; ) {
                    var rater = store.rater(raterId).orElseThrow();
                    var step = store.current(rater);
                    var key = step.key();
                    Function<Object, Void> submit = answers -> {
                        clock.advance(
                                step.kind() == Kind.PART
                                        ? budget.get(step.part()) * StrictMath.exp(0.35 * random.normal())
                                        : 2);
                        store.submit(rater, step, json.writeValueAsString(answers), instrument.version());
                        return null;
                    };
                    switch (step.kind()) {
                        case CONSENT ->
                            submit.apply(Map.of(
                                    "accepted",
                                    loaded.study().consent().statements().stream()
                                            .map(Study.Statement::id)
                                            .toList()));
                        case BACKGROUND ->
                            submit.apply(section(instrument.background().items(), none));
                        case EXIT -> submit.apply(section(instrument.exit().items(), none));
                        case ONBOARDING, CALIBRATION_REVIEW -> submit.apply(Map.of());
                        case CALIBRATION -> {
                            store.open(raterId, key);
                            submit.apply(section(instrument.calibration().items(), none));
                        }
                        case PART -> {
                            var assignments = store.assignments(raterId);
                            var position = assignments.stream()
                                    .map(SurveyStore.AssignmentRow::position)
                                    .toList()
                                    .indexOf(step.position());
                            if (stop.test(position)) {
                                return;
                            }
                            var code = assignments.get(position).exercise();
                            Function<Double, String> yes = bias ->
                                    1 / (1 + StrictMath.exp(-(1.4 + bias + quality.get(code) - severity.get(raterId))))
                                                    > random.uniform()
                                            ? "yes"
                                            : "no";
                            store.open(raterId, key);
                            submit.apply(section(instrument.itemsOf(step.part()), item -> {
                                if (!(item instanceof ChoiceItem choice)) {
                                    return null;
                                }
                                var values = choice.options().stream()
                                        .map(Instrument.Option::value)
                                        .toList();
                                var cell = raterId + "/" + code;
                                switch (item.id()) {
                                    case "RD1" -> {
                                        var value = readiness(code, raterId);
                                        rd1.put(cell, value);
                                        return value;
                                    }
                                    case "RD2" -> {
                                        var before = rd1.getOrDefault(cell, 3L);
                                        var shift = random.uniform() < 0.2 ? -1 : random.uniform() < 0.05 ? 1 : 0;
                                        var value = Math.min(5, Math.max(1, before + shift));
                                        rd2.put(cell, value);
                                        return value;
                                    }
                                    case "AF1" -> {
                                        return random.uniform() < 0.2 ? "yes" : "no";
                                    }
                                    case "AF2" -> {
                                        return random.uniform() < 0.65 ? "yes" : "no";
                                    }
                                    default -> {
                                        if (values.contains("na") && random.uniform() < 0.08) {
                                            return "na";
                                        }
                                        return values.contains("yes")
                                                ? yes.apply(item.id().startsWith("O") ? 0.5 : 0.0)
                                                : null;
                                    }
                                }
                            }));
                        }
                        default -> {
                            return;
                        }
                    }
                }
            }
        };

        for (var raterId : PLAN.keySet()) {
            simulation.rate(raterId, position -> raterId.equals(DROPOUT) && position >= 1);
        }
        // The backup takes over the exercises the dropout did not rate.
        simulation.rate(BACKUP, position -> false);
        store.assign(BACKUP, PLAN.get(DROPOUT).subList(1, 3), "backup", DROPOUT);
        simulation.rate(BACKUP, position -> false);

        // The tie breaker rates up to three exercises whose planned RD2 classes differ.
        var differing = loaded.study().exercises().stream()
                .map(Study.ExerciseEntry::code)
                .filter(code -> new HashSet<>(rd2.entrySet().stream()
                                        .filter(entry -> entry.getKey().endsWith("/" + code))
                                        .map(entry -> Readiness.classOf(entry.getValue()))
                                        .toList())
                                .size()
                        > 1)
                .limit(3)
                .toList();
        simulation.rate(TIE_BREAKER, position -> false);
        if (!differing.isEmpty()) {
            store.assign(TIE_BREAKER, differing, "tie_breaker", null);
        }
        simulation.rate(TIE_BREAKER, position -> false);
        return ExportArchive.data(loaded, store, List.of("main", "reserve"));
    }
}
