package exgen.survey.study;

/**
 * Trimming as the browser app trims, with JavaScript's {@code String.prototype.trim}: Java's
 * {@link String#strip()} keeps a no-break space, which JavaScript removes, so a text the app
 * treats as empty would otherwise count as an answer here.
 */
public final class Text {
    private Text() {}

    public static String trim(String text) {
        int start = 0;
        int end = text.length();
        while (start < end && isJavaScriptSpace(text.charAt(start))) {
            start++;
        }
        while (end > start && isJavaScriptSpace(text.charAt(end - 1))) {
            end--;
        }
        return text.substring(start, end);
    }

    /** ECMAScript's WhiteSpace and LineTerminator code points. */
    private static boolean isJavaScriptSpace(char character) {
        return switch (character) {
            case '\t', '\n', '\u000B', '\f', '\r', ' ', ' ', '﻿', ' ', ' ' -> true;
            default -> Character.getType(character) == Character.SPACE_SEPARATOR;
        };
    }
}
