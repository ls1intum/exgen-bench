package exgen.survey;

import jakarta.validation.constraints.NotNull;
import java.net.URI;
import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * How a deployment runs the survey, set through {@code SURVEY_*} environment variables.
 *
 * @param study the built study: the directory holding {@code study.yaml} and {@code exercises/}
 * @param instrument the instrument the study asks with
 * @param web the built browser app
 * @param publicUrl where raters reach the survey, for the links the commands print
 * @param secureCookies send the session cookie only over HTTPS; off for a local preview
 * @param legal the deployment's legal documents
 */
@Validated
@ConfigurationProperties("survey")
public record SurveyProperties(
        @NotNull String study,
        @NotNull String instrument,
        @NotNull String web,
        @NotNull URI publicUrl,
        @DefaultValue("true") boolean secureCookies,
        @DefaultValue Legal legal) {

    /** Paths are plain file system paths, relative to the working directory. */
    public Path studyPath() {
        return Path.of(study);
    }

    public Path instrumentPath() {
        return Path.of(instrument);
    }

    public Path webPath() {
        return Path.of(web);
    }

    /**
     * Each document is a URL to link to, or the path of a Markdown file the survey shows itself. The
     * operator's identity lives only here, never in the code, so the tool can be published blinded.
     *
     * @param required refuse to start without an imprint and a privacy notice, as a public
     *     deployment must have them
     */
    public record Legal(
            String imprint,
            String privacy,
            String accessibility,
            @DefaultValue("false") boolean required) {}
}
