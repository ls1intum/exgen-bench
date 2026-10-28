package exgen.survey.rating;

/** A request for a step other than the rater's current one: the page is stale, not broken. */
public class StepConflict extends RuntimeException {
    public StepConflict(String message) {
        super(message);
    }
}
