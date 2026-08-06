package de.tum.cit.aet.exgenfe71fb44df64e64f;

/**
 * A simple mutable bank account that supports deposits and withdrawals.
 * <p>
 * The class demonstrates encapsulation: the internal balance is kept private and can only be
 * accessed or modified through the public API. All mutating operations perform validation and
 * throw unchecked exceptions when the pre‑conditions are violated.
 */
public class BankAccount {
    /** The current balance of the account. */
    private double balance;

    /**
     * Creates a new {@code BankAccount} with the given initial balance.
     *
     * @param initialBalance the starting balance; must be non‑negative
     * @throws IllegalArgumentException if {@code initialBalance} is negative
     */
    public BankAccount(double initialBalance) {
        if (initialBalance < 0.0) {
            throw new IllegalArgumentException("Initial balance must be non‑negative");
        }
        this.balance = initialBalance;
    }

    /**
     * Deposits the given amount into the account.
     *
     * @param amount the amount to deposit; must be a finite positive number
     * @throws IllegalArgumentException if {@code amount} is not a finite positive number
     */
    public void deposit(double amount) {
        if (amount <= 0.0 || Double.isNaN(amount) || Double.isInfinite(amount)) {
            throw new IllegalArgumentException("Deposit amount must be a finite positive number");
        }
        this.balance += amount;
    }

    /**
     * Withdraws the given amount from the account.
     *
     * @param amount the amount to withdraw; must be a finite positive number
     * @throws IllegalArgumentException       if {@code amount} is not a finite positive number
     * @throws InsufficientFundsException if {@code amount} exceeds the current balance
     */
    public void withdraw(double amount) {
        if (amount <= 0.0 || Double.isNaN(amount) || Double.isInfinite(amount)) {
            throw new IllegalArgumentException("Withdraw amount must be a finite positive number");
        }
        if (amount > this.balance) {
            throw new InsufficientFundsException("Insufficient funds for withdrawal");
        }
        this.balance -= amount;
    }

    /**
     * Returns the current balance of the account.
     *
     * @return the balance as a {@code double}
     */
    public double getBalance() {
        return this.balance;
    }
}
