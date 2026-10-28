package exgen.survey.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

/**
 * A request that changes state must come from this host as JSON of a bounded size. The check
 * compares hosts, not origins, because behind a TLS-terminating proxy the server sees plain HTTP.
 */
class SameOriginFilter extends OncePerRequestFilter {
    static final int MAXIMUM_BODY = 256 * 1024;
    private static final Set<String> SAFE = Set.of("GET", "HEAD", "OPTIONS");

    private final JsonMapper json;

    SameOriginFilter(JsonMapper json) {
        this.json = json;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/") || SAFE.contains(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        var origin = request.getHeader("Origin");
        var host = origin == null ? null : hostOf(origin);
        if (host == null || !host.equals(request.getHeader("Host"))) {
            refuse(response, HttpStatus.FORBIDDEN, "cross-origin request refused");
        } else if (request.getContentType() == null
                || !request.getContentType().startsWith(MediaType.APPLICATION_JSON_VALUE)) {
            refuse(response, HttpStatus.UNSUPPORTED_MEDIA_TYPE, "expected JSON");
        } else if (request.getContentLengthLong() < 0) {
            refuse(response, HttpStatus.LENGTH_REQUIRED, "the request has no length");
        } else if (request.getContentLengthLong() > MAXIMUM_BODY) {
            refuse(response, HttpStatus.CONTENT_TOO_LARGE, "the request is too large");
        } else {
            chain.doFilter(request, response);
        }
    }

    private static String hostOf(String origin) {
        try {
            return URI.create(origin).getRawAuthority();
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private void refuse(HttpServletResponse response, HttpStatus status, String message) throws IOException {
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        json.writeValue(response.getOutputStream(), Map.of("error", message));
    }
}
