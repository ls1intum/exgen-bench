# Bank Account – Encapsulation and Exceptions

In this exercise we will build a tiny **bank account** class that stores a monetary balance.  You will make sure the class validates all inputs, protects its internal state, and signals error conditions with the appropriate unchecked exceptions.

## Public API

| Class | Constructor | Methods |
|-------|-------------|---------|
| `BankAccount` | `BankAccount(double initialBalance)` – creates a new account. | `void deposit(double amount)` – adds money.<br>`void withdraw(double amount)` – removes money.<br>`double getBalance()` – returns the current balance. |
| `InsufficientFundsException` | – | Unchecked exception thrown when a withdrawal would overdraw the account. |

Both classes are in the package `de.tum.cit.aet.exgenfe71fb44df64e64f`.

## Behaviour Rules

1. **Constructor validation** – The constructor must reject a negative initial balance by throwing an `IllegalArgumentException`. Zero or any positive amount creates the account with that balance.
2. **Deposit validation** – `deposit` must accept only *finite* positive numbers. If the amount is ≤ 0, `NaN`, or infinite, it throws `IllegalArgumentException`. A valid amount increases the balance by exactly that amount.
3. **Withdraw validation** – `withdraw` validates the amount in the same way as `deposit`. Invalid amounts cause `IllegalArgumentException`.
4. **Insufficient funds** – If a valid withdrawal amount exceeds the current balance, `withdraw` throws the unchecked `InsufficientFundsException` and leaves the balance unchanged.
5. **Successful withdrawal** – A valid amount that does not exceed the balance reduces the balance by exactly that amount.
6. **Balance query** – `getBalance()` returns the precise result of all successful deposits and withdrawals performed so far.
7. **Encapsulation** – The internal balance field must be `private`. External code may observe the balance only through `getBalance()`.

## Worked Examples

| Scenario | Calls | Result |
|----------|-------|--------|
| Normal flow | `new BankAccount(100.0)` → `deposit(50.0)` → `withdraw(70.0)` → `getBalance()` | `80.0` |
| Overdraw attempt | `new BankAccount(0.0)` → `withdraw(10.0)` | throws `InsufficientFundsException` (balance stays `0.0`) |
| Invalid deposit | `new BankAccount(10.0)` → `deposit(-5.0)` | throws `IllegalArgumentException` (balance stays `10.0`) |

## Tasks

[task][Constructor validation](<testid>192</testid>,<testid>198</testid>,<testid>186</testid>)
Implement the constructor so that it enforces rule 1.

[task][Deposit validation and behavior](<testid>191</testid>,<testid>193</testid>,<testid>199</testid>,<testid>195</testid>,<testid>188</testid>)
Write `deposit` to enforce rule 2 and update the balance correctly.

[task][Withdraw validation, insufficient funds handling](<testid>189</testid>,<testid>194</testid>,<testid>190</testid>)
Implement `withdraw` according to rules 3, 4 and 5.

[task][Balance query correctness](<testid>196</testid>,<testid>197</testid>,<testid>187</testid>)
Provide `getBalance` that returns the exact current balance (rule 6).