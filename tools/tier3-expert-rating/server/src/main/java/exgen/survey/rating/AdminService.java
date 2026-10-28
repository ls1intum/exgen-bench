package exgen.survey.rating;

import exgen.survey.rating.Step.Kind;
import exgen.survey.rating.SurveyStore.AssignmentRow;
import exgen.survey.rating.Views.AdminOverview;
import exgen.survey.study.Instrument.PartId;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Study.Role;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;
import java.util.stream.Stream;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * What the study team does while the study runs: follow progress and readiness agreement, issue new
 * links, move deadlines, and assign exercises to reserve raters as backups or tie breakers.
 */
@Service
public class AdminService {
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
        Predicate<AssignmentRow> complete = row -> steps.stream()
                .anyMatch(step -> step.raterId().equals(row.raterId())
                        && step.step()
                                .equals(Step.part(row.position(), PartId.D).key())
                        && step.submittedAt() != null);
        var raterStatus = store.raters().stream()
                .map(rater -> {
                    var own = steps.stream()
                            .filter(row -> row.raterId().equals(rater.id()))
                            .toList();
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
                                        case BACKGROUND -> "Background";
                                        case ONBOARDING -> "Introduction";
                                        case CALIBRATION, CALIBRATION_REVIEW -> "Practice";
                                        case WAITING -> "Waiting for assignment";
                                        case EXIT -> "Final survey";
                                        case DONE -> "Done";
                                        case DECLINED -> "Declined";
                                        case PART -> throw new IllegalStateException();
                                    };
                    return new Views.RaterStatus(
                            rater.id(),
                            rater.role().id(),
                            status,
                            Times.iso(last),
                            rater.deadline() == null ? null : rater.deadline().toString(),
                            mine.stream()
                                    .map(row ->
                                            new Views.AssignedExercise(row.exercise(), row.kind(), complete.test(row)))
                                    .toList());
                })
                .toList();
        var exercises = study.exercises().stream()
                .map(entry -> {
                    // A main rater's planned rating, or a reserve rater's backup for one, counts toward the
                    // planned ratings; a tie breaker's rating settles a disagreement and is kept apart.
                    var readiness = readiness(
                            assignments,
                            entry.code(),
                            complete,
                            row -> row.kind().equals("backup")
                                    || (row.kind().equals("planned")
                                            && store.rater(row.raterId())
                                                    .map(rater -> rater.role() == Role.MAIN)
                                                    .orElse(false)));
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
                    return new Views.ExerciseStatus(
                            entry.code(),
                            loaded.idOf().getOrDefault(entry.code(), ""),
                            entry.phase(),
                            study.ratingsPerExercise(),
                            readiness,
                            tieBreaker,
                            agreement);
                })
                .toList();
        return new AdminOverview(
                new Views.AdminOverviewStudy(study.id(), study.title(), study.ratingsPerExercise()),
                raterStatus,
                exercises);
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

    /** Assign exercises to a reserve rater: a backup for a main rater, or a tie breaker. */
    @Transactional
    public void assign(String raterId, String kind, String replaces, List<String> exercises) {
        // Validated under the lock, so two assignments at once cannot both pass the checks.
        store.lock(raterId);
        var study = loaded.study();
        var rater = store.rater(raterId).orElse(null);
        if (rater == null || rater.role() != Role.RESERVE) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "only reserve raters receive exercises during the study");
        }
        var own = store.assignments(rater.id()).stream()
                .map(AssignmentRow::exercise)
                .toList();
        var unknown =
                exercises.stream().filter(code -> study.exercise(code) == null).toList();
        if (!unknown.isEmpty() || exercises.stream().anyMatch(own::contains)) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST, "assign only study exercises the reserve rater has not rated");
        }
        if (own.size() + exercises.size() > 3) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "a reserve rater rates at most three exercises");
        }
        if (kind.equals("tie_breaker") && replaces != null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "a tie breaker replaces nobody");
        }
        if (kind.equals("backup")) {
            var replaced = replaces == null ? null : store.rater(replaces).orElse(null);
            var planned = replaced == null
                    ? List.<String>of()
                    : store.assignments(replaced.id()).stream()
                            .filter(row -> row.kind().equals("planned"))
                            .map(AssignmentRow::exercise)
                            .toList();
            if (replaced == null || replaced.role() != Role.MAIN || !planned.containsAll(exercises)) {
                throw new ApiException(
                        HttpStatus.BAD_REQUEST, "a backup takes over exercises planned for a main rater");
            }
        }
        store.assign(rater.id(), exercises, kind, replaces);
    }

    public void deadline(String raterId, LocalDate deadline) {
        requireRater(raterId);
        store.setDeadline(raterId, deadline);
    }

    /** A new personal link, which revokes the rater's earlier one. */
    public String link(String raterId) {
        requireRater(raterId);
        if (store.rater(raterId).orElseThrow().withdrawnAt() != null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "the rater withdrew, so they get no new link");
        }
        return store.issueLink(raterId);
    }

    private void requireRater(String raterId) {
        if (store.rater(raterId).isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "unknown rater");
        }
    }
}
