package exgen.survey.study;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * A rater's answer to one item: an option's {@code value}, the {@code values} of a multiple-choice
 * item, the closed follow-up {@code choice} of the selected option, and free {@code text}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Answer(
        Object value,
        @Size(max = 32) List<@Size(min = 1) String> values,
        @Size(min = 1) String choice,
        @Size(max = Answer.MAXIMUM_TEXT) String text) {

    public static final int MAXIMUM_TEXT = 4000;

    public Answer {
        value = OptionValues.of(value);
        values = values == null ? null : List.copyOf(values);
    }
}
