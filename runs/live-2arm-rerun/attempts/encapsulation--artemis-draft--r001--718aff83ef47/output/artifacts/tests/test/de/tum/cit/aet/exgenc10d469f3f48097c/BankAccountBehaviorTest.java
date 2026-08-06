package de.tum.cit.aet.exgenc10d469f3f48097c;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;
import java.lang.reflect.*;
import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class BankAccountBehaviorTest {

    private static final String CLASS_NAME = "de.tum.cit.aet.exgenc10d469f3f48097c.BankAccount";

    private Object newAccount() throws Exception {
        Class<?> clazz = Class.forName(CLASS_NAME);
        Constructor<?> ctor = clazz.getConstructor();
        return ctor.newInstance();
    }

    private Method getMethod(Class<?> clazz, String name, Class<?>... params) throws NoSuchMethodException {
        return clazz.getMethod(name, params);
    }

    @Test
    @StrictTimeout(1)
    void testDepositValidAndInvalid() throws Exception {
        Class<?> clazz = Class.forName(CLASS_NAME);
        Object account = newAccount();
        Method deposit = getMethod(clazz, "deposit", double.class);
        Method getBalance = getMethod(clazz, "getBalance");

        // valid deposit
        deposit.invoke(account, 100.0);
        assertEquals(100.0, (double) getBalance.invoke(account), 1e-9);

        // invalid deposit (zero)
        InvocationTargetException exZero = assertThrows(InvocationTargetException.class, () -> deposit.invoke(account, 0.0));
        assertTrue(exZero.getCause() instanceof AccountOperationException);

        // invalid deposit (negative)
        InvocationTargetException exNeg = assertThrows(InvocationTargetException.class, () -> deposit.invoke(account, -5.0));
        assertTrue(exNeg.getCause() instanceof AccountOperationException);
    }

    @Test
    @StrictTimeout(1)
    void testWithdrawValidAndInvalid() throws Exception {
        Class<?> clazz = Class.forName(CLASS_NAME);
        Object account = newAccount();
        Method deposit = getMethod(clazz, "deposit", double.class);
        Method withdraw = getMethod(clazz, "withdraw", double.class);
        Method getBalance = getMethod(clazz, "getBalance");

        // set up balance
        deposit.invoke(account, 50.0);
        assertEquals(50.0, (double) getBalance.invoke(account), 1e-9);

        // valid withdraw
        withdraw.invoke(account, 20.0);
        assertEquals(30.0, (double) getBalance.invoke(account), 1e-9);

        // invalid withdraw (zero)
        InvocationTargetException exZero = assertThrows(InvocationTargetException.class, () -> withdraw.invoke(account, 0.0));
        assertTrue(exZero.getCause() instanceof AccountOperationException);

        // invalid withdraw (negative)
        InvocationTargetException exNeg = assertThrows(InvocationTargetException.class, () -> withdraw.invoke(account, -10.0));
        assertTrue(exNeg.getCause() instanceof AccountOperationException);

        // invalid withdraw (exceeds balance)
        InvocationTargetException exOver = assertThrows(InvocationTargetException.class, () -> withdraw.invoke(account, 100.0));
        assertTrue(exOver.getCause() instanceof AccountOperationException);
    }

    @Test
    @StrictTimeout(1)
    void testBalance() throws Exception {
        Class<?> clazz = Class.forName(CLASS_NAME);
        Object account = newAccount();
        Method getBalance = getMethod(clazz, "getBalance");
        Method deposit = getMethod(clazz, "deposit", double.class);
        Method withdraw = getMethod(clazz, "withdraw", double.class);

        // initial balance
        assertEquals(0.0, (double) getBalance.invoke(account), 1e-9);

        // series of operations
        deposit.invoke(account, 200.0);
        withdraw.invoke(account, 50.0);
        deposit.invoke(account, 30.0);
        withdraw.invoke(account, 20.0);
        assertEquals(160.0, (double) getBalance.invoke(account), 1e-9);
    }
}
