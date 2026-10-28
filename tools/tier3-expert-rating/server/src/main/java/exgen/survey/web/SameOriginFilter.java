package exgen.survey.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
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
 * A request that changes state must come from this host as JSON of a bounded size. Every such
 * request is checked, whatever its path: the path a filter sees is not yet decoded, so a check on
 * {@code /api/} alone would miss {@code /%61pi/}. The check compares hosts, not origins, because
 * behind a TLS-terminating proxy the server sees plain HTTP.
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
        return SAFE.contains(request.getMethod());
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
        } else if (request.getContentLengthLong() > MAXIMUM_BODY) {
            refuse(response, HttpStatus.CONTENT_TOO_LARGE, "the request is too large");
        } else {
            // A body sent in chunks, as a proxy may forward it, is cut off where it grows too large.
            chain.doFilter(new LimitedRequest(request), response);
        }
    }

    /** A request whose body can be read only up to {@link #MAXIMUM_BODY} bytes. */
    private static final class LimitedRequest extends HttpServletRequestWrapper {
        LimitedRequest(HttpServletRequest request) {
            super(request);
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            var body = super.getInputStream();
            return new ServletInputStream() {
                private long read;

                @Override
                public int read() throws IOException {
                    int value = body.read();
                    if (value >= 0 && ++read > MAXIMUM_BODY) {
                        throw new BodyTooLarge();
                    }
                    return value;
                }

                @Override
                public int read(byte[] buffer, int offset, int length) throws IOException {
                    int count = body.read(buffer, offset, length);
                    if (count > 0 && (read += count) > MAXIMUM_BODY) {
                        throw new BodyTooLarge();
                    }
                    return count;
                }

                @Override
                public boolean isFinished() {
                    return body.isFinished();
                }

                @Override
                public boolean isReady() {
                    return body.isReady();
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    body.setReadListener(listener);
                }
            };
        }
    }

    /** Thrown while a body is read past the limit; answered with 413. */
    static final class BodyTooLarge extends IOException {
        BodyTooLarge() {
            super("the request is too large");
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
