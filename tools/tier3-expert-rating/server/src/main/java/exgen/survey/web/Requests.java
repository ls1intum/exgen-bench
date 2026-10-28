package exgen.survey.web;

import exgen.survey.study.Answer;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/** The request bodies the browser app sends, with the limits {@code shared/api.ts} declares. */
final class Requests {
    private Requests() {}

    static final String ITEM_ID = "^[A-Z][A-Z0-9]{1,7}$";

    record StepRequest(@NotNull @Size(min = 1, max = 64) String step) {}

    record AnswersRequest(
            @NotNull @Size(min = 1, max = 64) String step,
            @NotNull @Valid Map<@Pattern(regexp = ITEM_ID) String, @NotNull @Valid Answer> answers) {}

    record ConsentRequest(@NotNull @Size(max = 16) List<@NotNull @Size(min = 1) String> accepted) {}

    record EventsRequest(
            @NotNull @Size(min = 1, max = 64) String step,
            @NotNull @Size(min = 1, max = 50) List<@NotNull @Valid Event> events) {}

    record Event(
            @NotNull @Pattern(regexp = "view|file") String type,
            @NotNull @Size(min = 1, max = 512) String target) {}

    record AssignRequest(
            @NotNull @Size(min = 1) String rater,
            @NotNull @Pattern(regexp = "backup|tie_breaker") String kind,
            @Size(min = 1) String replaces,
            @NotNull @Size(min = 1, max = 3) List<@NotNull @Size(min = 1) String> exercises) {}

    record DeadlineRequest(
            @NotNull @Size(min = 1) String rater, @NotNull LocalDate deadline) {}

    record LinkRequest(@NotNull @Size(min = 1) String rater) {}
}
