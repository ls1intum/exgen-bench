package de.tum.cit.aet.exgenlegalstatetransitions;

/**
 * Represents an order that progresses through a fixed sequence of states.
 * <p>
 * The allowed state progression is:
 * {@code CREATED → PAID → FULFILLED → COMPLETED}.
 * Any attempt to transition to a non‑adjacent state is rejected.
 */
public class Order {
    private OrderState state;

    /**
     * Creates a new order initially in the {@link OrderState#CREATED} state.
     */
    public Order() {
        this.state = OrderState.CREATED;
    }

    /**
     * Returns the current state of the order.
     *
     * @return the current {@link OrderState}
     */
    public OrderState getState() {
        return state;
    }

    /**
     * Attempts to advance the order to the given {@code target} state.
     * <p>
     * The transition is successful only if {@code target} is the immediate next
     * state in the defined sequence. On success the internal state is updated
     * and {@code true} is returned. Otherwise the state remains unchanged and
     * {@code false} is returned.
     *
     * @param target the desired next state
     * @return {@code true} if the transition was legal and performed, otherwise {@code false}
     */
    public boolean advanceTo(OrderState target) {
        if (target == null) {
            return false;
        }
        // legal transition if target ordinal is exactly one greater than current
        if (target.ordinal() == state.ordinal() + 1) {
            state = target;
            return true;
        }
        return false;
    }
}
