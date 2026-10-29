package exgen.survey.rating;

import exgen.survey.rating.Step.Kind;
import exgen.survey.rating.SurveyStore.AssignmentRow;
import exgen.survey.rating.SurveyStore.RaterRow;
import exgen.survey.rating.SurveyStore.StepRow;
import exgen.survey.rating.Views.AdminOverview;
import exgen.survey.study.Instrument.PartId;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Study.Role;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * What the study team does while the study runs. The plan in study.yaml is where the study starts;
 * from the dashboard, the team adds raters, assigns exercises to any rater and removes assignments
 * nobody has started, issues and revokes links, moves deadlines, and withdraws a rater at their
 * request. Every change is logged and exported, so the deviations from the plan can be reported.
 */
@Service
public class AdminService {
    private static final Pattern RATER_ID = Pattern.compile("^[A-Z][A-Z0-9]{0,7}$");
    private static final Set<String> KINDS = Set.of("additional", "backup", "tie_breaker");

    private final LoadedStudy loaded;
    private final SurveyStore store;
    private final RaterService raters;

    public AdminService(LoadedStudy loaded, SurveyStore store, RaterService raters) {
        this.loaded = loaded;
        this.store = store;
        this.raters = raters;
    }

    public AdminOverview overview() {
        var study = loaded.study();
        var steps = store.steps();
        var assignments = store.assignments();
        var linked = store.linked();
        Predicate<AssignmentRow> complete = row -> submitted(steps, row.raterId(), Step.part(row.position(), PartId.D));
        var raterStatus = store.raters().stream()
                .map(rater -> raterStatus(rater, steps, assignments, linked))
                .toList();
        // The study team's own test runs would distort how long the parts take.
        var testers = store.raters().stream()
                .filter(rater -> rater.role() == Role.TEST)
                .map(RaterRow::id)
                .collect(Collectors.toSet());
        var exercises = study.exercises().stream()
                .map(entry -> {
                    // Each planned rating of a main rater counts once: the rating itself once it is
                    // complete, else a complete backup that stands in for it. Tie breakers settle a
                    // disagreement and are kept apart; any other rating counts on its own.
                    var readiness = plannedReadiness(assignments, entry.code(), complete);
                    var tieBreaker = readiness(
                            assignments,
                            entry.code(),
                            complete,
                            row -> row.kind().equals("tie_breaker"));
                    var classes = new HashSet<>(
                            readiness.stream().map(Readiness::classOf).toList());
                    var agreement = readiness.size() < study.ratingsPerExercise()
                            ? "pending"
                            : classes.size() == 1 ? "agree" : !tieBreaker.isEmpty() ? "resolved" : "differ";
                    var own = assignments.stream()
                            .filter(row -> row.exercise().equals(entry.code()))
                            .toList();
                    var ratings = (int) own.stream().filter(complete).count();
                    var inProgress = (int) own.stream()
                            .filter(row -> !complete.test(row) && store.started(row.raterId(), row.position()))
                            .count();
                    return new Views.ExerciseStatus(
                            entry.code(),
                            loaded.idOf().getOrDefault(entry.code(), ""),
                            entry.phase(),
                            study.ratingsPerExercise(),
                            readiness,
                            tieBreaker,
                            agreement,
                            ratings,
                            inProgress);
                })
                .toList();
        return new AdminOverview(
                new Views.AdminOverviewStudy(study.id(), study.title(), study.ratingsPerExercise()),
                raterStatus,
                exercises,
                timing(steps.stream()
                        .filter(row -> !testers.contains(row.raterId()))
                        .toList()),
                feedback(steps),
                store.changes().reversed().stream()
                        .map(change -> new Views.Change(
                                Times.iso(change.at()), change.action(), change.raterId(), change.detail()))
                        .toList());
    }

    private Views.RaterStatus raterStatus(
            RaterRow rater, List<StepRow> steps, List<AssignmentRow> assignments, Set<String> linked) {
        var own = steps.stream().filter(row -> row.raterId().equals(rater.id())).toList();
        var last = own.stream()
                .flatMap(row -> Stream.of(row.openedAt(), row.draftSavedAt(), row.submittedAt()))
                .filter(Objects::nonNull)
                .max(Instant::compareTo)
                .orElse(null);
        var step = store.current(rater);
        var mine = assignments.stream()
                .filter(row -> row.raterId().equals(rater.id()))
                .toList();
        var index = mine.stream()
                .map(AssignmentRow::position)
                .toList()
                .indexOf(step.kind() == Kind.PART ? step.position() : -1);
        var status = rater.withdrawnAt() != null
                ? "Withdrawn"
                : step.kind() == Kind.PART
                        ? "Exercise " + (index + 1) + ", Part " + step.part()
                        : switch (step.kind()) {
                            case CONSENT -> own.isEmpty() ? "Not started" : "Consent";
                            case ONBOARDING -> "Introduction";
                            case BACKGROUND -> "About you";
                            case WAITING -> "Waiting for exercises";
                            case EXIT -> "Looking back";
                            case BRIEFS -> "Briefs";
                            case DONE -> "Done";
                            case DECLINED -> "Declined";
                            case PART -> throw new IllegalStateException();
                        };
        // Consent, introduction and background; four parts per exercise; looking back and the briefs
        // once there are exercises.
        var keys = new ArrayList<String>(Step.ONCE.stream().map(Kind::id).toList());
        for (var row : mine) {
            for (var part : PartId.values()) {
                keys.add(Step.part(row.position(), part).key());
            }
        }
        if (!mine.isEmpty()) {
            keys.addAll(Step.CLOSING.stream().map(Kind::id).toList());
        }
        var done = (int) keys.stream()
                .filter(key -> own.stream().anyMatch(row -> row.step().equals(key) && row.submittedAt() != null))
                .count();
        var minutes = Math.round(own.stream()
                        .filter(row -> row.step().startsWith("exercise-")
                                && row.openedAt() != null
                                && row.submittedAt() != null)
                        .mapToLong(row -> Duration.between(row.openedAt(), row.submittedAt())
                                .toSeconds())
                        .sum()
                / 60.0);
        return new Views.RaterStatus(
                rater.id(),
                rater.role().id(),
                status,
                Times.iso(last),
                rater.deadline() == null ? null : rater.deadline().toString(),
                rater.addedAt() != null,
                rater.withdrawnAt() != null,
                submitted(steps, rater.id(), Step.of(Kind.EXIT)),
                linked.contains(rater.id()),
                new Views.Progress(done, keys.size()),
                minutes,
                mine.stream()
                        .map(row -> {
                            var parts = (int) Stream.of(PartId.values())
                                    .filter(part -> submitted(steps, rater.id(), Step.part(row.position(), part)))
                                    .count();
                            return new Views.AssignedExercise(
                                    row.exercise(),
                                    row.kind(),
                                    row.replaces(),
                                    parts,
                                    store.started(rater.id(), row.position()),
                                    parts == PartId.values().length);
                        })
                        .toList());
    }

    private static boolean submitted(List<StepRow> steps, String raterId, Step step) {
        return steps.stream()
                .anyMatch(row ->
                        row.raterId().equals(raterId) && row.step().equals(step.key()) && row.submittedAt() != null);
    }

    /** The median minutes of the submitted parts, which shows whether the design's budget holds. */
    private List<Views.Timing> timing(List<StepRow> steps) {
        return loaded.instrument().questionnaire().parts().stream()
                .map(part -> {
                    var minutes = steps.stream()
                            .filter(row -> row.step().startsWith("exercise-")
                                    && row.step().endsWith("-" + part.id())
                                    && row.openedAt() != null
                                    && row.submittedAt() != null)
                            .map(row -> Duration.between(row.openedAt(), row.submittedAt())
                                            .toSeconds()
                                    / 60.0)
                            .sorted()
                            .toList();
                    Double median = minutes.isEmpty()
                            ? null
                            : Math.round((minutes.size() % 2 == 1
                                                    ? minutes.get(minutes.size() / 2)
                                                    : (minutes.get(minutes.size() / 2 - 1)
                                                                    + minutes.get(minutes.size() / 2))
                                                            / 2)
                                            * 10)
                                    / 10.0;
                    return new Views.Timing(part.id().name(), part.title(), part.minutes(), median, minutes.size());
                })
                .toList();
    }

    /**
     * The free text of the closing steps, newest first: what raters say about the survey itself and
     * about the briefs, each under the title of its section.
     */
    private List<Views.Feedback> feedback(List<StepRow> steps) {
        var instrument = loaded.instrument();
        var sections = Map.of(Kind.EXIT.id(), instrument.exit(), Kind.BRIEFS.id(), instrument.briefs());
        var roles = store.raters().stream()
                .collect(Collectors.toMap(RaterRow::id, rater -> rater.role().id()));
        return steps.stream()
                .filter(row -> sections.containsKey(row.step()) && row.submittedAt() != null)
                .sorted(Comparator.comparing(StepRow::submittedAt).reversed())
                .flatMap(row -> {
                    var section = sections.get(row.step());
                    var answers = raters.answersOf(row.raterId(), row.step());
                    return section.items().stream()
                            .filter(item -> answers.containsKey(item.id())
                                    && answers.get(item.id()).text() != null
                                    && !answers.get(item.id()).text().isBlank())
                            .map(item -> new Views.Feedback(
                                    row.raterId(),
                                    roles.get(row.raterId()),
                                    section.title(),
                                    item.id(),
                                    item.prompt(),
                                    answers.get(item.id()).text(),
                                    Times.iso(row.submittedAt())));
                })
                .toList();
    }

    /** RD2 of an exercise's planned ratings of main raters, each taken by its backup while it is open. */
    private List<Long> plannedReadiness(
            List<AssignmentRow> assignments, String code, Predicate<AssignmentRow> complete) {
        var readiness = new ArrayList<Long>();
        // Removed, unstarted assignments remain planned slots: a backup can still fill them.
        var plannedAssignments = store.raters().stream()
                .filter(rater -> rater.role() == Role.MAIN)
                .flatMap(rater -> store.assignmentHistory(rater.id()).stream())
                .toList();
        for (var planned : plannedAssignments) {
            if (!planned.exercise().equals(code)
                    || !planned.kind().equals("planned")
                    || store.rater(planned.raterId())
                            .map(rater -> rater.role() != Role.MAIN)
                            .orElse(true)) {
                continue;
            }
            var rating = complete.test(planned)
                    ? Optional.of(planned)
                    : assignments.stream()
                            .filter(row -> row.kind().equals("backup")
                                    && row.exercise().equals(code)
                                    && planned.raterId().equals(row.replaces())
                                    && complete.test(row))
                            .findFirst();
            rating.flatMap(this::rd2).ifPresent(readiness::add);
        }
        return readiness;
    }

    private Optional<Long> rd2(AssignmentRow row) {
        var answer = raters.answersOf(
                        row.raterId(), Step.part(row.position(), PartId.D).key())
                .get("RD2");
        return answer != null && answer.value() instanceof Long value ? Optional.of(value) : Optional.empty();
    }

    /** RD2 of the completed ratings of an exercise that count. */
    private List<Long> readiness(
            List<AssignmentRow> assignments,
            String code,
            Predicate<AssignmentRow> complete,
            Predicate<AssignmentRow> counts) {
        return assignments.stream()
                .filter(row -> row.exercise().equals(code) && counts.test(row) && complete.test(row))
                .flatMap(row -> {
                    var answer = raters.answersOf(
                                    row.raterId(),
                                    Step.part(row.position(), PartId.D).key())
                            .get("RD2");
                    return answer != null && answer.value() instanceof Long value ? Stream.of(value) : Stream.empty();
                })
                .toList();
    }

    /** Add a rater during the study, with the exercises to rate, and return their personal link. */
    @Transactional
    public String addRater(String id, String role, String deadline, List<String> exercises) {
        if (!RATER_ID.matcher(id).matches()) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "a rater ID is a capital letter and up to seven capitals or digits, such as P7");
        }
        // Under a lock on the study, so two of the team adding the same ID cannot both pass.
        store.lockStudy();
        if (store.rater(id).isPresent()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "The study already has a rater " + id + ".");
        }
        var parsedRole = parseRole(role);
        var date = deadline == null ? null : parseDate(deadline);
        requireExercises(exercises, List.of());
        store.addRater(id, parsedRole, date);
        store.logChange(
                "rater added",
                id,
                id + " (" + parsedRole.id() + ")" + (date == null ? "" : ", deadline " + date)
                        + (exercises.isEmpty() ? "" : ", exercises " + String.join(", ", exercises)));
        if (!exercises.isEmpty()) {
            store.assign(id, exercises, "additional", null);
        }
        return link(id);
    }

    /**
     * Assign exercises to any rater: an additional rating, a backup that stands in for another
     * rater's rating of the same exercise, or a tie breaker.
     */
    @Transactional
    public void assign(String raterId, String kind, String replaces, List<String> exercises) {
        // Validated under the lock, so two assignments at once cannot both pass the checks.
        store.lock(raterId);
        var rater = activeRater(raterId);
        if (!KINDS.contains(kind)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "assign as additional, backup, or tie_breaker");
        }
        var own = store.assignments(rater.id()).stream()
                .map(AssignmentRow::exercise)
                .toList();
        requireExercises(exercises, own);
        if (!kind.equals("backup") && replaces != null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "only a backup replaces another rater");
        }
        if (kind.equals("backup")) {
            var replaced = replaces == null ? null : store.rater(replaces).orElse(null);
            var theirs = replaced == null
                    ? List.<String>of()
                    : store.assignmentHistory(replaced.id()).stream()
                            .map(AssignmentRow::exercise)
                            .toList();
            if (replaced == null || replaced.id().equals(rater.id()) || !theirs.containsAll(exercises)) {
                throw new ApiException(
                        HttpStatus.BAD_REQUEST, "a backup takes over exercises that were assigned to another rater");
            }
        }
        // Looking back already answered: the new exercises come after it, whatever the rater does now.
        var finished =
                store.step(rater.id(), Kind.EXIT.id()).map(StepRow::submittedAt).isPresent();
        store.assign(rater.id(), exercises, kind, replaces);
        store.logChange(
                "exercises assigned",
                rater.id(),
                String.join(", ", exercises) + " to " + rater.id() + " as " + kind.replace('_', ' ')
                        + (replaces == null ? "" : " for " + replaces)
                        + (finished ? ", after “Looking back”" : ""));
    }

    /** Remove an assignment the rater has not started; a started one keeps its answers. */
    @Transactional
    public void unassign(String raterId, String exercise) {
        store.lock(raterId);
        requireRater(raterId);
        var assignment = store.assignments(raterId).stream()
                .filter(row -> row.exercise().equals(exercise))
                .findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, raterId + " is not assigned " + exercise));
        if (store.started(raterId, assignment.position())) {
            throw new ApiException(
                    HttpStatus.CONFLICT,
                    raterId + " has started " + exercise + ", so the assignment and its answers stay");
        }
        store.unassign(raterId, assignment.position());
        store.logChange("assignment removed", raterId, exercise + " from " + raterId);
    }

    @Transactional
    public void deadline(String raterId, LocalDate deadline) {
        requireRater(raterId);
        store.setDeadline(raterId, deadline);
        store.logChange("deadline changed", raterId, raterId + " until " + deadline);
    }

    /** A new personal link, which revokes the rater's earlier one. */
    @Transactional
    public String link(String raterId) {
        activeRater(raterId);
        var token = store.issueLink(raterId);
        store.logChange("link issued", raterId, "a new link for " + raterId + "; earlier links stop working");
        return token;
    }

    /** A new link for the study team, which revokes the team's earlier one. */
    @Transactional
    public String teamLink() {
        var token = store.issueLink(null);
        store.logChange("link issued", null, "a new link for the study team; its earlier link stops working");
        return token;
    }

    /** Stop a rater's link without issuing a new one, such as when a link leaked or a rater left. */
    @Transactional
    public void revoke(String raterId) {
        requireRater(raterId);
        store.revokeLinks(raterId);
        store.logChange("link revoked", raterId, raterId + " has no working link");
    }

    /** Delete everything a rater answered, at their request; the rater stays in the plan. */
    @Transactional
    public void withdraw(String raterId) {
        requireRater(raterId);
        store.withdraw(raterId);
        store.logChange("withdrawn", raterId, raterId + " withdrew; their answers are deleted");
    }

    private RaterRow activeRater(String raterId) {
        var rater = requireRater(raterId);
        if (rater.withdrawnAt() != null) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST, raterId + " withdrew, so nothing more is assigned or linked");
        }
        return rater;
    }

    private RaterRow requireRater(String raterId) {
        return store.rater(raterId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "unknown rater"));
    }

    private void requireExercises(List<String> exercises, List<String> own) {
        var unknown = exercises.stream()
                .filter(code -> loaded.study().exercise(code) == null)
                .toList();
        if (!unknown.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "not exercises of the study: " + String.join(", ", unknown));
        }
        if (new HashSet<>(exercises).size() != exercises.size()
                || exercises.stream().anyMatch(own::contains)) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST, "assign each exercise once, and none the rater already rates");
        }
    }

    private static Role parseRole(String role) {
        try {
            return Role.of(role);
        } catch (IllegalArgumentException | NullPointerException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "a role is main, reserve, pilot, or test");
        }
    }

    private static LocalDate parseDate(String date) {
        try {
            return LocalDate.parse(date);
        } catch (DateTimeParseException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "the deadline is not a date");
        }
    }
}
