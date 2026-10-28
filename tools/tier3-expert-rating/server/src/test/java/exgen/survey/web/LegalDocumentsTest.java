package exgen.survey.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import exgen.survey.SurveyProperties;
import java.net.URI;
import org.junit.jupiter.api.Test;

class LegalDocumentsTest {
    static SurveyProperties with(SurveyProperties.Legal legal) {
        return new SurveyProperties(
                "study", "instrument.yaml", "web", URI.create("https://survey.example.org"), true, legal);
    }

    @Test
    void refusesAPublicDeploymentWithoutImprintAndPrivacyNotice() {
        assertThatThrownBy(() -> new LegalDocuments(
                        with(new SurveyProperties.Legal("https://example.org/imprint", null, null, true))))
                .hasMessageContaining("SURVEY_LEGAL_PRIVACY");
        assertThat(new LegalDocuments(with(new SurveyProperties.Legal(null, null, null, false))).links())
                .isEmpty();
    }

    @Test
    void refusesADocumentFileItCannotRead() {
        assertThatThrownBy(() -> new LegalDocuments(
                        with(new SurveyProperties.Legal("https://example.org/imprint", "missing.md", null, true))))
                .hasMessageContaining("the privacy document missing.md cannot be read");
    }
}
