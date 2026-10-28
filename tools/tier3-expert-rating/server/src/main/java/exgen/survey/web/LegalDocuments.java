package exgen.survey.web;

import exgen.survey.SurveyProperties;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * The deployment's imprint, privacy notice and accessibility statement. Each is a URL the footer
 * links to, or a Markdown file the survey shows on its own page; the file is read on every request,
 * so a corrected text needs no restart. Nothing about the operator is built into the server.
 */
@Component
public class LegalDocuments {
    private static final Map<String, String> TITLES =
            Map.of("imprint", "Imprint", "privacy", "Privacy", "accessibility", "Accessibility");

    /** A document as the footer lists it; {@code href} is external or a page of the survey. */
    public record Link(String id, String title, String href) {}

    public record Document(String title, String markdown) {}

    private final Map<String, String> sources = new LinkedHashMap<>();

    public LegalDocuments(SurveyProperties properties) {
        var legal = properties.legal();
        put("imprint", legal.imprint());
        put("privacy", legal.privacy());
        put("accessibility", legal.accessibility());
        if (legal.required() && (!sources.containsKey("imprint") || !sources.containsKey("privacy"))) {
            throw new IllegalStateException(
                    "a public deployment needs an imprint and a privacy notice: set SURVEY_LEGAL_IMPRINT and SURVEY_LEGAL_PRIVACY");
        }
        sources.forEach((id, source) -> {
            if (!external(source) && !Files.isReadable(Path.of(source))) {
                throw new IllegalStateException("the " + id + " document " + source + " cannot be read");
            }
        });
    }

    private void put(String id, String source) {
        if (source != null && !source.isBlank()) {
            sources.put(id, source.strip());
        }
    }

    private static boolean external(String source) {
        return source.startsWith("https://") || source.startsWith("http://");
    }

    public List<Link> links() {
        var links = new ArrayList<Link>();
        sources.forEach(
                (id, source) -> links.add(new Link(id, TITLES.get(id), external(source) ? source : "/legal/" + id)));
        return links;
    }

    public Optional<Document> document(String id) {
        var source = sources.get(id);
        if (source == null || external(source)) {
            return Optional.empty();
        }
        try {
            return Optional.of(new Document(TITLES.get(id), Files.readString(Path.of(source), StandardCharsets.UTF_8)));
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
