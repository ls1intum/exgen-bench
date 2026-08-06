package de.tum.cit.aet.exgenfe71fb44df64e64f;

/**
 * Unchecked exception indicating that a withdrawal would overdraw the account.
 */
public class InsufficientFundsException extends RuntimeException {
    /**
     * Creates a new {@code InsufficientFundsException} with the given message.
     *
     * @param message the detail message
     */
    public InsufficientFundsException(String message) {
        super(message);
    }
}
