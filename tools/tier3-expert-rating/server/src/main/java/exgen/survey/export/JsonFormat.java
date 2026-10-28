package exgen.survey.export;

import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.core.util.DefaultIndenter;
import tools.jackson.core.util.DefaultPrettyPrinter;
import tools.jackson.core.util.Separators;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;

/**
 * JSON files as the study's exports have always been written: two-space indentation, {@code "key":
 * value}, and {@code []} and {@code {}} for empty lists and objects, so an export reads the same
 * whichever version of the server wrote it.
 */
public final class JsonFormat {
    private static final DefaultIndenter INDENTER = new DefaultIndenter("  ", "\n");
    private static final ObjectWriter WRITER = JsonMapper.builder()
            .changeDefaultPropertyInclusion(inclusion -> inclusion.withValueInclusion(JsonInclude.Include.NON_NULL))
            .build()
            .writer()
            .with(new DefaultPrettyPrinter(Separators.createDefaultInstance()
                            .withObjectNameValueSpacing(Separators.Spacing.AFTER)
                            .withObjectEmptySeparator("")
                            .withArrayEmptySeparator(""))
                    .withObjectIndenter(INDENTER)
                    .withArrayIndenter(INDENTER));

    private JsonFormat() {}

    public static String write(Object value) {
        return WRITER.writeValueAsString(value);
    }
}
