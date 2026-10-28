package exgen.survey.web;

import exgen.survey.SurveyProperties;
import exgen.survey.rating.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The browser app. Its hashed assets are cached for good; every other path is the app's page, which
 * decides what to show from the session, and is revalidated so a new build reaches every rater.
 */
@RestController
class WebAppController {
    private final Path web;

    WebAppController(SurveyProperties properties) {
        this.web = properties.webPath().toAbsolutePath().normalize();
        if (!Files.isRegularFile(web.resolve("index.html"))) {
            throw new IllegalStateException("the browser app is not built at " + web + "; run bun run survey:web");
        }
    }

    @GetMapping("/**")
    ResponseEntity<Resource> page(HttpServletRequest request) {
        var path = request.getRequestURI().substring(1);
        if (path.startsWith("api/")) {
            throw new ApiException(HttpStatus.NOT_FOUND, "no such endpoint");
        }
        if (path.startsWith("assets/")) {
            var file = web.resolve(path).normalize();
            if (!file.startsWith(web.resolve("assets")) || !Files.isRegularFile(file)) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(java.time.Duration.ofDays(365))
                            .cachePublic()
                            .immutable())
                    .contentType(
                            MediaTypeFactory.getMediaType(file.getFileName().toString())
                                    .orElse(MediaType.APPLICATION_OCTET_STREAM))
                    .body(new FileSystemResource(file));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noCache())
                .contentType(MediaType.TEXT_HTML)
                .body(new FileSystemResource(web.resolve("index.html")));
    }
}
