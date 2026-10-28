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

    public record RaterInfo(String id, String deadline) {}

    public record AdminSession(String kind, AdminStudy study) implements Session {}

    public record AdminStudy(String title) {}

    public record ProgressSegment(String label, String state) {}

    public sealed interface StepView {}

    public record ConsentView(String kind, String summary, String details, List<Study.Statement> statements)
            implements StepView {}

    public record SectionView(String kind, String key, Map<String, Answer> draft) implements StepView {}

    public record OnboardingView(String kind, String key) implements StepView {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CalibrationView(
            String kind, String key, boolean opened, Map<String, Answer> draft, ObjectNode exercise)
            implements StepView {}

    public record CalibrationReviewView(
            String kind, String key, Map<String, Answer> answers, Map<String, Study.Reference> reference)
            implements StepView {}

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

    public record StatusView(String kind) implements StepView {}

    /** What the study team sees: status per rater, and readiness agreement per exercise. */
    public record AdminOverview(AdminOverviewStudy study, List<RaterStatus> raters, List<ExerciseStatus> exercises) {}

    public record AdminOverviewStudy(String id, String title, int ratingsPerExercise) {}

    public record RaterStatus(
            String id,
            String role,
            String status,
            String lastActivity,
            String deadline,
            List<AssignedExercise> exercises) {}

    public record AssignedExercise(String code, String kind, boolean complete) {}

    /**
     * @param readiness RD2 of the planned ratings, including backups
     * @param tieBreaker RD2 of tie breakers
     */
    public record ExerciseStatus(
            String code,
            String id,
            String phase,
            int planned,
            List<Long> readiness,
            List<Long> tieBreaker,
            String agreement) {}
}
