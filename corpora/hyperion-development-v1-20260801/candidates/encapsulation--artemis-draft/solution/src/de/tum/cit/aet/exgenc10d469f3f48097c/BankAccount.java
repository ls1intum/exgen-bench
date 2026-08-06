package de.tum.cit.aet.exgenc10d469f3f48097c;

/**
 * A simple bank account that encapsulates a monetary balance.
 * <p>
 * It supports depositing and withdrawing money while enforcing basic validation rules.
 * </p>
 */
public class BankAccount {
    private double balance;

    /**
     * Creates a new {@code BankAccount} with an initial balance of {@code 0.0}.
     */
    public BankAccount() {
        this.balance = 0.0;
    }

    /**
     * Deposits the given {@code amount} into this account.
     *
     * @param amount the amount to deposit; must be greater than {@code 0}
     * @throws AccountOperationException if {@code amount} is not positive
     */
    public void deposit(double amount) throws AccountOperationException {
        if (amount <= 0) {
            throw new AccountOperationException("Deposit amount must be positive");
        }
        this.balance += amount;
    }

    /**
     * Withdraws the given {@code amount} from this account.
     *
     * @param amount the amount to withdraw; must be greater than {@code 0} and not exceed the current balance
     * @throws AccountOperationException if {@code amount} is not positive or exceeds the current balance
     */
    public void withdraw(double amount) throws AccountOperationException {
        if (amount <= 0) {
            throw new AccountOperationException("Withdrawal amount must be positive");
        }
        if (amount > this.balance) {
            throw new AccountOperationException("Insufficient funds");
        }
        this.balance -= amount;
    }

    /**
     * Returns the current balance of this account.
     *
     * @return the current balance
     */
    public double getBalance() {
        return this.balance;
    }
}
