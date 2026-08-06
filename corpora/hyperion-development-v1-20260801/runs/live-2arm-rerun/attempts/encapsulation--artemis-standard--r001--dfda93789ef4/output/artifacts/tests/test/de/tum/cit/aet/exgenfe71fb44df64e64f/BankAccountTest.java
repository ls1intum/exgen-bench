package de.tum.cit.aet.exgenfe71fb44df64e64f;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class BankAccountTest {

    // ---- Constructor tests (S1) ----
    @Test
    @StrictTimeout(1)
    void testConstructorRejectsNegative() {
        assertThrows(IllegalArgumentException.class, () -> new BankAccount(-10.0));
    }

    @Test
    @StrictTimeout(1)
    void testConstructorAcceptsZero() {
        BankAccount account = new BankAccount(0.0);
        assertEquals(0.0, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testConstructorAcceptsPositive() {
        BankAccount account = new BankAccount(123.45);
        assertEquals(123.45, account.getBalance(), 0.0);
    }

    // ---- Deposit tests (S2) ----
    @Test
    @StrictTimeout(1)
    void testDepositValid() {
        BankAccount account = new BankAccount(0.0);
        account.deposit(50.0);
        assertEquals(50.0, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testDepositVeryLargeAmount() {
        BankAccount account = new BankAccount(0.0);
        double large = Double.MAX_VALUE / 2.0;
        account.deposit(large);
        assertEquals(large, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testDepositInvalidZeroOrNegative() {
        BankAccount account = new BankAccount(0.0);
        assertThrows(IllegalArgumentException.class, () -> account.deposit(0.0));
        assertThrows(IllegalArgumentException.class, () -> account.deposit(-5.0));
    }

    @Test
    @StrictTimeout(1)
    void testDepositInvalidNaN() {
        BankAccount account = new BankAccount(0.0);
        assertThrows(IllegalArgumentException.class, () -> account.deposit(Double.NaN));
    }

    @Test
    @StrictTimeout(1)
    void testDepositInvalidInfinity() {
        BankAccount account = new BankAccount(0.0);
        assertThrows(IllegalArgumentException.class, () -> account.deposit(Double.POSITIVE_INFINITY));
    }

    // ---- Withdraw tests (S3) ----
    @Test
    @StrictTimeout(1)
    void testWithdrawValid() {
        BankAccount account = new BankAccount(100.0);
        account.withdraw(30.0);
        assertEquals(70.0, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testWithdrawInvalidAmount() {
        BankAccount account = new BankAccount(100.0);
        assertThrows(IllegalArgumentException.class, () -> account.withdraw(0.0));
        assertThrows(IllegalArgumentException.class, () -> account.withdraw(-10.0));
        assertThrows(IllegalArgumentException.class, () -> account.withdraw(Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> account.withdraw(Double.NEGATIVE_INFINITY));
    }

    @Test
    @StrictTimeout(1)
    void testWithdrawInsufficientFunds() {
        BankAccount account = new BankAccount(10.0);
        assertThrows(InsufficientFundsException.class, () -> account.withdraw(20.0));
        // balance must stay unchanged
        assertEquals(10.0, account.getBalance(), 0.0);
    }

    // ---- Balance query tests (S4) ----
    @Test
    @StrictTimeout(1)
    void testBalanceAfterSequence() {
        BankAccount account = new BankAccount(100.0);
        account.deposit(50.0);
        account.withdraw(70.0);
        assertEquals(80.0, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testBalanceInitiallyZero() {
        BankAccount account = new BankAccount(0.0);
        assertEquals(0.0, account.getBalance(), 0.0);
    }

    @Test
    @StrictTimeout(1)
    void testBalanceAfterSingleDeposit() {
        BankAccount account = new BankAccount(0.0);
        account.deposit(25.0);
        assertEquals(25.0, account.getBalance(), 0.0);
    }
}
