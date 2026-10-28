package exgen.survey.web;

import exgen.survey.SurveyProperties;
import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.SurveyStore.Holder;
import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Exchanges a personal link for the session cookie, and leaves the link out of the address bar. */
@RestController
class LinkController {
    private final SurveyStore store;
    private final SurveyProperties properties;

    LinkController(SurveyStore store, SurveyProperties properties) {
        this.store = store;
        this.properties = properties;
    }

    @GetMapping("/r/{token}")
    ResponseEntity<Void> exchange(@PathVariable String token) {
        var holder = store.holderOf(token);
        // The app explains how to get a valid link; a revoked one must not keep an old session.
        var cookie = ResponseCookie.from(LinkCookie.name(properties), holder.isPresent() ? token : "")
                .httpOnly(true)
                .secure(properties.secureCookies())
                .sameSite("Strict")
                .path("/");
        if (holder.isEmpty()) {
            cookie.maxAge(0);
        }
        var target = holder.isPresent() && holder.get() instanceof Holder.Admin ? "/admin" : "/";
        return ResponseEntity.status(HttpStatus.SEE_OTHER)
                .location(URI.create(target))
                .header(HttpHeaders.SET_COOKIE, cookie.build().toString())
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .build();
    }
}
