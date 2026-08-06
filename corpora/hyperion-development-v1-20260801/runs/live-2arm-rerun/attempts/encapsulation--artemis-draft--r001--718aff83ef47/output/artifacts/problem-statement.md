# Bank Account Exercise

In this exercise you will implement a simple **BankAccount** class that encapsulates a monetary balance and validates operations using a checked exception.

## Public API

```java
public class BankAccount {
    /**
     * Creates a new bank account with an initial balance of {@code 0.0}.
     */
    public BankAccount();

    /**
     * Adds {@code amount} to the account balance.
     *
     * @param amount the amount to deposit; must be {@code > 0}
     * @throws AccountOperationException if {@code amount <= 0}
     */
    public void deposit(double amount) throws AccountOperationException;

    /**
     * Removes {@code amount} from the account balance.
     *
     * @param amount the amount to withdraw; must be {@code > 0} and not exceed the current balance
     * @throws AccountOperationException if {@code amount <= 0} or if the amount is larger than the current balance
     */
    public void withdraw(double amount) throws AccountOperationException;

    /**
     * Returns the current balance of the account.
     *
     * @return the exact balance as a {@code double}
     */
    public double getBalance();
}
```

The exception type is provided for you:

```java
public class AccountOperationException extends Exception {
    public AccountOperationException(String message) { super(message); }
}
```

## Tasks

[task][Implement deposit operation](<testid>182</testid>)
Implement the {@code deposit} method so that it throws an {@code AccountOperationException} for non‑positive amounts and adds the amount to the internal balance otherwise.

[task][Implement withdraw operation](<testid>180</testid>)
Implement the {@code withdraw} method so that it throws an {@code AccountOperationException} for non‑positive amounts, for amounts larger than the current balance, and otherwise subtracts the amount from the balance.

[task][Implement balance query](<testid>181</testid>)
Implement the {@code getBalance} method and ensure the constructor initializes the balance to {@code 0.0}. The method must return the exact current balance after any sequence of valid deposits and withdrawals.

[task][Create BankAccount class](<testid>183</testid>,<testid>184</testid>,<testid>185</testid>)
Provide the {@code BankAccount} class with the public API described above. The class must be concrete, have a public no‑arg constructor, and expose the three public methods with the exact signatures.