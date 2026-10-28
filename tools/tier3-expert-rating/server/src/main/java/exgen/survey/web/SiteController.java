package exgen.survey.web;

import exgen.survey.rating.ApiException;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** What every page shows without a link: the footer's legal documents. */
@RestController
@RequestMapping("/api")
class SiteController {
    private final LegalDocuments legal;

    SiteController(LegalDocuments legal) {
        this.legal = legal;
    }

    @GetMapping("/site")
    Map<String, List<LegalDocuments.Link>> site() {
        return Map.of("legal", legal.links());
    }

    @GetMapping("/legal/{id}")
    LegalDocuments.Document document(@PathVariable String id) {
        return legal.document(id).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "no such document"));
    }
}
