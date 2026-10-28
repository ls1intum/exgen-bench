package exgen.survey.study;

/**
 * An option's value is text or a whole number, as {@code instrument.yaml} writes it, and the two
 * never match: {@code "1"} is not {@code 1}. Numbers are held as {@link Long}, so a value read from
 * YAML equals the same value read from a rater's JSON.
 */
public final class OptionValues {
    private OptionValues() {}

    /** The value in its canonical form, or an error for anything but text or a whole number. */
    public static Object of(Object value) {
        return switch (value) {
            case null -> null;
            case String text when !text.isEmpty() -> text;
            case Integer number -> number.longValue();
            case Long number -> number;
            case Double number when number == Math.rint(number) && !number.isInfinite() -> number.longValue();
            default -> throw new IllegalArgumentException("a value is a non-empty text or a whole number");
        };
    }
}
