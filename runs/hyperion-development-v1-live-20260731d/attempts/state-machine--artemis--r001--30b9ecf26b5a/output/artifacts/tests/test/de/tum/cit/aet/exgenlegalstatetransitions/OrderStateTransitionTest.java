package de.tum.cit.aet.exgenlegalstatetransitions;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Behavioral tests for the {@code Order} state machine.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class OrderStateTransitionTest {

    private Object createOrder() throws Exception {
        Class<?> clazz = Class.forName("de.tum.cit.aet.exgenlegalstatetransitions.Order");
        Constructor<?> ctor = clazz.getDeclaredConstructor();
        return ctor.newInstance();
    }

    private OrderState getState(Object order) throws Exception {
        Method m = order.getClass().getMethod("getState");
        return (OrderState) m.invoke(order);
    }

    private boolean advanceTo(Object order, OrderState target) throws Exception {
        Method m = order.getClass().getMethod("advanceTo", OrderState.class);
        return (Boolean) m.invoke(order, target);
    }

    @Test
    @StrictTimeout(1)
    void testInitialState() throws Exception {
        Object order = createOrder();
        assertEquals(OrderState.CREATED, getState(order), "New order should be in CREATED state");
    }

    @Test
    @StrictTimeout(1)
    void testLegalTransitions() throws Exception {
        Object order = createOrder();
        // CREATED -> PAID
        assertTrue(advanceTo(order, OrderState.PAID), "CREATED->PAID should succeed");
        assertEquals(OrderState.PAID, getState(order));
        // PAID -> FULFILLED
        assertTrue(advanceTo(order, OrderState.FULFILLED), "PAID->FULFILLED should succeed");
        assertEquals(OrderState.FULFILLED, getState(order));
        // FULFILLED -> COMPLETED
        assertTrue(advanceTo(order, OrderState.COMPLETED), "FULFILLED->COMPLETED should succeed");
        assertEquals(OrderState.COMPLETED, getState(order));
    }

    @Test
    @StrictTimeout(1)
    void testIllegalTransitions() throws Exception {
        Object order = createOrder();
        // Same state illegal
        assertFalse(advanceTo(order, OrderState.CREATED), "CREATED->CREATED should be illegal");
        assertEquals(OrderState.CREATED, getState(order));
        // Backward illegal: move to PAID first, then back to CREATED
        assertTrue(advanceTo(order, OrderState.PAID), "CREATED->PAID should succeed");
        assertEquals(OrderState.PAID, getState(order));
        assertFalse(advanceTo(order, OrderState.CREATED), "PAID->CREATED should be illegal");
        assertEquals(OrderState.PAID, getState(order));
        // Non-adjacent forward illegal: from PAID try to go to COMPLETED
        assertFalse(advanceTo(order, OrderState.COMPLETED), "PAID->COMPLETED should be illegal");
        assertEquals(OrderState.PAID, getState(order));
    }

    @Test
    @StrictTimeout(1)
    void testNullTargetReturnsFalse() throws Exception {
        Object order = createOrder();
        boolean result = advanceTo(order, null);
        assertFalse(result, "R4: null target should be treated as illegal and return false");
        assertEquals(OrderState.CREATED, getState(order), "R4: state must remain unchanged after null target");
    }

    @Test
    @StrictTimeout(1)
    void testAdvanceToAfterCompletedIsIllegal() throws Exception {
        Object order = createOrder();
        // progress through the legal sequence to COMPLETED
        assertTrue(advanceTo(order, OrderState.PAID), "CREATED->PAID should succeed");
        assertTrue(advanceTo(order, OrderState.FULFILLED), "PAID->FULFILLED should succeed");
        assertTrue(advanceTo(order, OrderState.COMPLETED), "FULFILLED->COMPLETED should succeed");
        // now any further advance should be illegal (including same state)
        boolean result = advanceTo(order, OrderState.COMPLETED);
        assertFalse(result, "R4: after COMPLETED, advanceTo should return false");
        assertEquals(OrderState.COMPLETED, getState(order), "R5: state should remain COMPLETED");
    }
}

