## Library checkout summary

In this exercise we work with a list of library checkout events. Each event records the identifier of the member who borrowed an item and how many days the item is overdue. Your job is to implement a single static method that analyses the list and produces a summary containing:

* the total number of overdue events,
* the total fees (overdue days multiplied by a daily fee of **1.0**), and
* for every member that has at least one overdue event, a per‑member breakdown of count and fees.

All other events (zero or negative overdue days) are ignored.

[task][Compute library summary](<testid>90</testid>,<testid>92</testid>,<testid>91</testid>,<testid>89</testid>)

---

### Public API

| Type | Signature |
|------|-----------|
| `CheckoutEvent` | `public record CheckoutEvent(String memberId, int daysOverdue)` |
| `MemberSummary` | `public record MemberSummary(int overdueCount, double fees)` |
| `LibrarySummary` | `public record LibrarySummary(int totalOverdueCount, double totalFees, java.util.Map<String, MemberSummary> perMember)` |
| `LibraryProcessor` | `public class LibraryProcessor { public static LibrarySummary summarize(java.util.List<CheckoutEvent> events) }` |

The `summarize` method must never return `null` and must never modify the supplied list.

---

### Worked example

```java
List<CheckoutEvent> events = List.of(
    new CheckoutEvent("Alice", 3),   // overdue → 3 days
    new CheckoutEvent("Bob", 0),     // not overdue
    new CheckoutEvent("Alice", -2),  // not overdue
    new CheckoutEvent("Bob", 5)      // overdue → 5 days
);

LibrarySummary result = LibraryProcessor.summarize(events);
```

The expected `result` is:

* `totalOverdueCount = 2`
* `totalFees = 8.0`  (3 × 1.0 + 5 × 1.0)
* `perMember` contains two entries:
  * `"Alice" → MemberSummary(overdueCount = 1, fees = 3.0)`
  * `"Bob"   → MemberSummary(overdueCount = 1, fees = 5.0)`

If the input list is empty, the method must return a `LibrarySummary` with `totalOverdueCount == 0`, `totalFees == 0.0` and an empty `perMember` map.

---

### Edge cases you need to handle

* **Empty input** – the summary must reflect zero counts and an empty map.
* **Only non‑overdue events** – the result is the same as for an empty list.
* **Multiple overdue events for the same member** – counts and fees are accumulated.
* **Duplicate member identifiers** – treat them as the same member; group their overdue events.
* **Events with `daysOverdue <= 0`** – ignore them completely; they do not affect any output field.

Implement the method according to the rules above; the provided tests will verify all required behaviour.