package exgen.survey.rating;

import com.fasterxml.jackson.annotation.JsonInclude;
import exgen.survey.study.Answer;
import exgen.survey.study.Instrument;
import exgen.survey.study.Study;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.node.ObjectNode;

/**
 * The JSON the browser app receives, the contract {@code shared/api.ts} describes. The server
 * decides which step a rater is on and sends only that step's material; the app renders it.
 */
public final class Views {
    private Views() {}

    public sealed interface Session permits RaterSession, AdminSession {}

    public record RaterSession(
            String kind,
            RaterStudy study,
            RaterInfo rater,
            Instrument instrument,
            List<ProgressSegment> progress,
            StepView step)
            implements Session {}

    public record RaterStudy(String title, Study.Contact contact) {}

    public record RaterInfo(String id) {}

    public record AdminSession(String kind, AdminStudy study) implements Session {}

    public record AdminStudy(String title) {}

    public record ProgressSegment(String label, String state) {}

    public sealed interface StepView {}

    public record ConsentView(String kind, String summary, String details, List<Study.Statement> statements)
            implements StepView {}

    public record SectionView(String kind, String key, Map<String, Answer> draft) implements StepView {}

    public record OnboardingView(String kind, String key) implements StepView {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PartView(
            String kind,
            String key,
            int position,
            int total,
            String part,
            boolean opened,
            Map<String, Map<String, Answer>> earlier,
            Map<String, Answer> draft,
            ObjectNode exercise)
            implements StepView {}

    /** Every brief of the study, in course order; {@code rated} marks those of the rater's own exercises. */
    public record BriefsView(String kind, String key, Map<String, Answer> draft, List<Brief> briefs)
            implements StepView {}

    public record Brief(int number, String phase, String brief, boolean rated) {}

    public record StatusView(String kind) implements StepView {}

    /**
     * What the study team sees: each rater's progress and assignments, each exercise's ratings and
     * agreement, how long the parts take against the design's budget, the raters' comments on the
     * survey, and every change the team made.
     */
    public record AdminOverview(
            AdminOverviewStudy study,
            List<RaterStatus> raters,
            List<ExerciseStatus> exercises,
            List<Timing> timing,
            List<Feedback> feedback,
            List<Change> changes) {}

    public record AdminOverviewStudy(String id, String title, int ratingsPerExercise) {}

    public record RaterStatus(
            String id,
            String role,
            String status,
            String lastActivity,
            String deadline,
            boolean added,
            boolean withdrawn,
            boolean lookedBack,
            boolean link,
            Progress progress,
            long minutes,
            List<AssignedExercise> exercises) {}

    public record Progress(int done, int total) {}

    public record AssignedExercise(
            String code, String kind, String replaces, int parts, boolean started, boolean complete) {}

    /**
     * @param readiness RD2 of the planned ratings of main raters, including backups
     * @param tieBreaker RD2 of tie breakers
     * @param ratings completed ratings of any kind and role
     * @param inProgress assignments under way
     */
    public record ExerciseStatus(
            String code,
            String id,
            String phase,
            int planned,
            List<Long> readiness,
            List<Long> tieBreaker,
            String agreement,
            int ratings,
            int inProgress) {}

    /** Minutes the submitted parts took, against the minutes the design budgets for the part. */
    public record Timing(String part, String title, int budget, Double median, int count) {}

    /** @param section the title of the step the text was given in */
    public record Feedback(
            String rater, String role, String section, String item, String prompt, String text, String at) {}

    public record Change(String at, String action, String rater, String detail) {}
}
