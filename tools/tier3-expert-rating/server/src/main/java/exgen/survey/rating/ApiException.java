package exgen.survey.rating;

import org.springframework.http.HttpStatus;

/** A request the server refuses, with the status and the message the browser app shows. */
public class ApiException extends RuntimeException {
    private final HttpStatus status;

    public ApiException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus status() {
        return status;
    }
}
