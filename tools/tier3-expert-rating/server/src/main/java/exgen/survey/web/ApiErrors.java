package exgen.survey.web;

import exgen.survey.rating.ApiException;
import exgen.survey.rating.StepConflict;
import java.util.Map;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Every refused request answers with {@code {"error": "..."}}, which the browser app shows. */
@RestControllerAdvice
class ApiErrors {
    private static final Logger LOG = LoggerFactory.getLogger(ApiErrors.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, String>> refused(ApiException error) {
        return error(error.status(), error.getMessage());
    }

    @ExceptionHandler(StepConflict.class)
    ResponseEntity<Map<String, String>> stale(StepConflict error) {
        return error(HttpStatus.CONFLICT, error.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<Map<String, String>> invalid(MethodArgumentNotValidException error) {
        return error(
                HttpStatus.BAD_REQUEST,
                error.getBindingResult().getFieldErrors().stream()
                        .map(field -> field.getField() + " " + field.getDefaultMessage())
                        .sorted()
                        .collect(Collectors.joining("; ")));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<Map<String, String>> unreadable(HttpMessageNotReadableException error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SameOriginFilter.BodyTooLarge) {
                return error(HttpStatus.CONTENT_TOO_LARGE, "the request is too large");
            }
        }
        return error(HttpStatus.BAD_REQUEST, "the request is malformed");
    }

    @ExceptionHandler({HandlerMethodValidationException.class, MissingRequestHeaderException.class})
    ResponseEntity<Map<String, String>> malformed(Exception error) {
        return error(HttpStatus.BAD_REQUEST, "the request is malformed");
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    ResponseEntity<Map<String, String>> unsupported(HttpMediaTypeNotSupportedException error) {
        return error(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "expected JSON");
    }

    @ExceptionHandler({NoResourceFoundException.class, HttpRequestMethodNotSupportedException.class})
    ResponseEntity<Map<String, String>> unknown(Exception error) {
        return error(HttpStatus.NOT_FOUND, "no such endpoint");
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<Map<String, String>> failed(Exception error) {
        LOG.error("request failed", error);
        return error(HttpStatus.INTERNAL_SERVER_ERROR, "internal error");
    }

    private static ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
        return ResponseEntity.status(status).body(Map.of("error", message));
    }
}
