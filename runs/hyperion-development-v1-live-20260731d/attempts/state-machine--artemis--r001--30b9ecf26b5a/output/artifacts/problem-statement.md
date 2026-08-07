# Order State Machine Exercise

We model a simple order lifecycle. An order starts in the **CREATED** state and may only move forward one step at a time through the fixed sequence:

```
CREATED → PAID → FULFILLED → COMPLETED
```

Your task is to implement the `Order` class so that it respects these rules.

## Public API

### `OrderState`
```java
public enum OrderState {
    CREATED,
    PAID,
    FULFILLED,
    COMPLETED
}
```

### `Order`
```java
public class Order {
    /**
     * Creates a new order. The initial state must be {@link OrderState#CREATED}.
     */
    public Order();

    /**
     * Returns the current state of the order.
     */
    public OrderState getState();

    /**
     * Tries to advance the order to {@code target}.
     *
     * @param target the state we want to move to
     * @return {@code true} if {@code target} is the immediate next state in the
     *         sequence and the transition is performed; {@code false} otherwise.
     */
    public boolean advanceTo(OrderState target);
}
```

## Behaviour

* **Initial state** – After construction an order must report `CREATED`.
* **Legal transition** – Calling `advanceTo` with the *exact* next state returns `true` and updates the stored state.
* **Illegal transition** – Any other target (same state, previous state, or a non‑adjacent future state) returns `false` and leaves the state unchanged.
* **Query** – `getState()` always returns the current state.

## Worked examples

```java
Order o = new Order();
System.out.println(o.getState());               // → CREATED

boolean ok = o.advanceTo(OrderState.PAID);
System.out.println(ok);                         // → true
System.out.println(o.getState());               // → PAID

ok = o.advanceTo(OrderState.COMPLETED); // illegal jump
System.out.println(ok);                 // → false
System.out.println(o.getState());       // → PAID (unchanged)
```

## Tasks

[task][Initial state and class structure](<testid>85</testid>,<testid>81</testid>,<testid>82</testid>,<testid>83</testid>)
Implement the `Order` class so that a newly created instance reports the state `CREATED`. Ensure the class, its public constructor, and its public methods exist as declared in the API.

[task][Legal forward transitions](<testid>84</testid>)
Make `advanceTo` return `true` and update the state when the target is the immediate next state in the sequence (`CREATED→PAID`, `PAID→FULFILLED`, `FULFILLED→COMPLETED`).

[task][Illegal transitions handling](<testid>87</testid>,<testid>88</testid>,<testid>86</testid>)
Make `advanceTo` return `false` and leave the state unchanged for any illegal target (same state, backward move, or non‑adjacent forward move).

---

*All public members must match the signatures shown above exactly.*