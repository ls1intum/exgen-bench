package de.tum.cit.aet.exgenfe71fb44df64e64f;

/**
 * A simple mutable bank account that supports deposits and withdrawals.
 * <p>
 * Students must implement the method bodies while keeping the balance encapsulated.
 */
public class BankAccount {
    /** The current balance of the account. */
    private double balance;

    /**
     * Creates a new {@code BankAccount} with the given initial balance.
     *
     * @param initialBalance the starting balance; must be non‑negative
     */
    public BankAccount(double initialBalance) {
        // TODO S1: implement constructor validation and initialization
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Deposits the given amount into the account.
     *
     * @param amount the amount to deposit; must be a finite positive number
     */
    public void deposit(double amount) {
        // TODO S2: implement deposit validation and balance update
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Withdraws the given amount from the account.
     *
     * @param amount the amount to withdraw; must be a finite positive number
     */
    public void withdraw(double amount) {
        // TODO S3: implement withdraw validation, insufficient-funds check and balance update
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Returns the current balance of the account.
     *
     * @return the balance as a {@code double}
     */
    public double getBalance() {
        // TODO S4: return the current balance
        throw new UnsupportedOperationException("Not implemented");
    }
}
