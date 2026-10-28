package exgen.survey.rating;

import exgen.survey.rating.Step.Kind;
import exgen.survey.rating.SurveyStore.Holder;
import exgen.survey.rating.SurveyStore.RaterRow;
import exgen.survey.rating.Views.ProgressSegment;
import exgen.survey.rating.Views.Session;
import exgen.survey.rating.Views.StepView;
import exgen.survey.study.Answer;
import exgen.survey.study.AnswerRules;
import exgen.survey.study.Instrument;
import exgen.survey.study.Instrument.Item;
import exgen.survey.study.Instrument.PartId;
import exgen.survey.study.LoadedStudy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * What a rater does: see the current step, consent, open a step's material, save a draft, submit
 * answers, and download their own answers. Each request names the step it belongs to, and a request
 * for any other step than the current one is refused as stale.
 */
@Service
public class RaterService {
    private static final TypeReference<LinkedHashMap<String, Answer>> ANSWERS = new TypeReference<>() {};
    private static final List<String> CALIBRATION_MATERIAL = Instrument.MATERIAL.stream()
            .filter(material -> !material.equals("findings"))
            .toList();

    private final LoadedStudy loaded;
    private final SurveyStore store;
    private final JsonMapper json;

    public RaterService(LoadedStudy loaded, SurveyStore store, JsonMapper json) {
        this.loaded = loaded;
        this.store = store;
        this.json = json;
    }

    /** What the server answers on every request that changes a rater's state: the new session. */
    public Session session(Holder holder) {
        var study = loaded.study();
        return switch (holder) {
            case Holder.Admin admin -> new Views.AdminSession("admin", new Views.AdminStudy(study.title()));
            case Holder.Rater(var stale) -> {
                var rater = store.rater(stale.id()).orElse(stale);
                var step = store.current(rater);
                yield new Views.RaterSession(
                        "rater",
                        new Views.RaterStudy(study.title(), study.contact()),
                        new Views.RaterInfo(
                                rater.id(),
                                rater.deadline() == null
                                        ? null
                                        : rater.deadline().toString()),
                        loaded.instrument(),
                        progress(rater, step),
                        stepView(rater, step));
            }
        };
    }

    /**
     * Lock the rater for the request and read them again: a rater who withdrew while the request was
     * under way can no longer change anything.
     */
    private RaterRow lock(RaterRow rater) {
        store.lock(rater.id());
        var current = store.rater(rater.id()).orElseThrow();
        if (current.withdrawnAt() != null) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "open your personal link to continue");
        }
        return current;
    }

    @Transactional
    public void consent(RaterRow stale, List<String> accepted) {
        var rater = lock(stale);
        var step = currentStepFor(rater, Kind.CONSENT.id());
        var required = loaded.study().consent().statements().stream()
                .map(statement -> statement.id())
                .toList();
        if (accepted.isEmpty()) {
            store.decline(rater.id());
        } else if (accepted.containsAll(required)) {
            store.submit(rater, step, json.writeValueAsString(Map.of("accepted", required)), version());
        } else {
            throw new ApiException(HttpStatus.BAD_REQUEST, "every consent statement must be accepted to take part");
        }
    }

    @Transactional
    public void open(RaterRow stale, String key) {
        var rater = lock(stale);
        currentStepFor(rater, key);
        store.open(rater.id(), key);
    }

    @Transactional
    public Instant draft(RaterRow stale, String key, Map<String, Answer> answers) {
        var rater = lock(stale);
        currentStepFor(rater, key);
        return store.saveDraft(rater.id(), key, json.writeValueAsString(answers));
    }

    /** Store a step's answers, or return the issues that keep them from being complete. */
    @Transactional
    public List<AnswerRules.Issue> submit(RaterRow stale, String key, Map<String, Answer> answers) {
        var rater = lock(stale);
        var step = currentStepFor(rater, key);
        if (step.kind() == Kind.CONSENT) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "consent has its own endpoint");
        }
        var items = itemsOf(step);
        var issues = AnswerRules.issues(items, answers);
        if (!issues.isEmpty()) {
            return issues;
        }
        if ((step.kind() == Kind.PART || step.kind() == Kind.CALIBRATION)
                && store.step(rater.id(), key)
                        .map(SurveyStore.StepRow::openedAt)
                        .isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT, "this step's material was never opened");
        }
        store.submit(rater, step, json.writeValueAsString(AnswerRules.normalize(items, answers)), version());
        return List.of();
    }

    @Transactional
    public void events(RaterRow stale, String key, List<SurveyStore.ViewEvent> events) {
        var rater = lock(stale);
        currentStepFor(rater, key);
        store.logEvents(rater.id(), key, events);
    }

    /** A rater's own answers, which they may download at the end of the session. */
    public RaterExport ownAnswers(String raterId) {
        var steps = store.steps(raterId).stream()
                .filter(row -> row.submittedAt() != null)
                .map(row -> new RaterExport.Submitted(
                        row.step(), Times.iso(row.submittedAt()), json.readTree(row.answers())))
                .toList();
        return new RaterExport(loaded.study().title(), raterId, steps);
    }

    public record RaterExport(String study, String rater, List<Submitted> steps) {
        public record Submitted(String step, String submitted_at, JsonNode answers) {}
    }

    private String version() {
        return loaded.instrument().version();
    }

    /** The rater's current step, which must be the one the request names and take answers. */
    private Step currentStepFor(RaterRow rater, String key) {
        var step = store.current(rater);
        if (!step.key().equals(key)) {
            throw new StepConflict("this page is out of date: the current step is " + step.key());
        }
        if (!step.answerable()) {
            throw new StepConflict("there is nothing to answer at this point");
        }
        return step;
    }

    List<Item> itemsOf(Step step) {
        var instrument = loaded.instrument();
        return switch (step.kind()) {
            case BACKGROUND -> instrument.background().items();
            case EXIT -> instrument.exit().items();
            case CALIBRATION -> instrument.calibration().items();
            case PART -> instrument.itemsOf(step.part());
            default -> List.of();
        };
    }

    /** Stored answers of a step, or none. */
    public Map<String, Answer> answersOf(String raterId, String key) {
        return store.step(raterId, key)
                .map(SurveyStore.StepRow::answers)
                .<Map<String, Answer>>map(answers -> json.readValue(answers, ANSWERS))
                .orElseGet(LinkedHashMap::new);
    }

    /** A step's draft, without answers to items the instrument no longer asks in that step. */
    private Map<String, Answer> draftOf(String raterId, Step step) {
        var ids = itemsOf(step).stream().map(Item::id).toList();
        var draft = new LinkedHashMap<String, Answer>();
        store.step(raterId, step.key())
                .map(SurveyStore.StepRow::draft)
                .map(stored -> json.readValue(stored, ANSWERS))
                .ifPresent(stored -> stored.forEach((item, answer) -> {
                    if (ids.contains(item)) {
                        draft.put(item, answer);
                    }
                }));
        return draft;
    }

    private List<ProgressSegment> progress(RaterRow rater, Step step) {
        var positions = store.assignments(rater.id()).stream()
                .map(SurveyStore.AssignmentRow::position)
                .toList();
        var submitted = store.steps(rater.id()).stream()
                .filter(row -> row.submittedAt() != null)
                .map(SurveyStore.StepRow::step)
                .toList();
        var segments = new ArrayList<ProgressSegment>();
        var once = List.of(
                Map.entry("Consent", Kind.CONSENT),
                Map.entry("Background", Kind.BACKGROUND),
                Map.entry("Introduction", Kind.ONBOARDING),
                Map.entry("Practice", Kind.CALIBRATION_REVIEW));
        for (var entry : once) {
            var kind = entry.getValue();
            var current = step.kind() == kind || (kind == Kind.CALIBRATION_REVIEW && step.kind() == Kind.CALIBRATION);
            segments.add(segment(entry.getKey(), submitted.contains(kind.id()), current));
        }
        for (int index = 0; index < positions.size(); index++) {
            int position = positions.get(index);
            segments.add(segment(
                    "Exercise " + (index + 1),
                    submitted.contains(Step.part(position, PartId.D).key()),
                    step.kind() == Kind.PART && step.position() == position));
        }
        segments.add(segment("Final survey", submitted.contains(Kind.EXIT.id()), step.kind() == Kind.EXIT));
        return segments;
    }

    private static ProgressSegment segment(String label, boolean done, boolean current) {
        return new ProgressSegment(label, current ? "current" : done ? "done" : "todo");
    }

    private StepView stepView(RaterRow rater, Step step) {
        var study = loaded.study();
        var key = step.key();
        var opened =
                store.step(rater.id(), key).map(SurveyStore.StepRow::openedAt).isPresent();
        return switch (step.kind()) {
            case CONSENT ->
                new Views.ConsentView(
                        "consent",
                        study.consent().summary(),
                        study.consent().details(),
                        study.consent().statements());
            case BACKGROUND, EXIT -> new Views.SectionView(step.kind().id(), key, draftOf(rater.id(), step));
            case ONBOARDING -> new Views.OnboardingView("onboarding", key);
            case CALIBRATION -> {
                var exercise = loaded.exercises().get(study.calibration().code());
                yield new Views.CalibrationView(
                        "calibration",
                        key,
                        opened,
                        draftOf(rater.id(), step),
                        opened && exercise != null ? LoadedStudy.viewOf(exercise, CALIBRATION_MATERIAL) : null);
            }
            case CALIBRATION_REVIEW ->
                new Views.CalibrationReviewView(
                        "calibration_review",
                        key,
                        answersOf(rater.id(), "calibration"),
                        study.calibration().reference());
            case PART -> {
                var assignments = store.assignments(rater.id());
                var positions = assignments.stream()
                        .map(SurveyStore.AssignmentRow::position)
                        .toList();
                var earlier = new LinkedHashMap<String, Map<String, Answer>>();
                for (var part : PartId.values()) {
                    if (part.compareTo(step.part()) < 0) {
                        earlier.put(
                                part.name(),
                                answersOf(
                                        rater.id(),
                                        Step.part(step.position(), part).key()));
                    }
                }
                yield new Views.PartView(
                        "part",
                        key,
                        positions.indexOf(step.position()) + 1,
                        positions.size(),
                        step.part().name(),
                        opened,
                        earlier,
                        draftOf(rater.id(), step),
                        opened
                                ? LoadedStudy.viewOf(
                                        exerciseAt(assignments, step.position()),
                                        loaded.instrument().materialThrough(step.part()))
                                : null);
            }
            case WAITING, DONE, DECLINED -> new Views.StatusView(step.kind().id());
        };
    }

    private tools.jackson.databind.node.ObjectNode exerciseAt(
            List<SurveyStore.AssignmentRow> assignments, int position) {
        return assignments.stream()
                .filter(row -> row.position() == position)
                .map(row -> loaded.exercises().get(row.exercise()))
                .filter(Objects::nonNull)
                .findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "no exercise at this position"));
    }
}
