package de.tum.cit.aet.exgenc10d469f3f48097c;

/**
 * Checked exception indicating an illegal operation on a {@link BankAccount}.
 */
public class AccountOperationException extends Exception {
    /**
     * Creates a new {@code AccountOperationException} with the given detail message.
     *
     * @param message the detail message
     */
    public AccountOperationException(String message) {
        super(message);
    }
}
