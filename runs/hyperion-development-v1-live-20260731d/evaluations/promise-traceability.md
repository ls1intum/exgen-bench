| case | system | promise.witnessed_ratio | promise.unwitnessed_claims | promise.unclassified_normative_units | api.member_reference_ratio | exception.assertthrows_ratio | boundary.literal_ratio | tests.behavioural_methods | tests.assertions | tests.assertion_density | tests.assertionless_methods | tests.structural_lane_present |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bicycle-share-summary | artemis | n/a | 0 | 2 | 0.82 (9/11) | n/a | n/a | 4 | 12 | 3 | 0 | false |
| collections | artemis | 0.40 (2/5) | 3 | 1 | 1.00 (9/9) | 0.00 (0/1) | 1.00 (1/1) | 7 | 14 | 2 | 0 | true |
| graph-cycles | artemis | 1.00 (1/1) | 0 | 2 | 0.75 (3/4) | n/a | 1.00 (7/7) | 6 | 10 | 1.666667 | 0 | false |
| immutable-value | artemis | 1.00 (4/4) | 0 | 2 | 0.71 (5/7) | 1.00 (1/1) | n/a | 15 | 28 | 1.866667 | 0 | false |
| inheritance | artemis | 0.00 (0/1) | 1 | 0 | 0.90 (9/10) | n/a | n/a | 12 | 17 | 1.416667 | 0 | true |
| interval-merge | artemis | 1.00 (3/3) | 0 | 3 | 1.00 (6/6) | 1.00 (1/1) | n/a | 8 | 31 | 3.875 | 0 | true |
| intro-formatting | artemis | n/a | 0 | 2 | 1.00 (2/2) | n/a | 1.00 (1/1) | 7 | 7 | 1 | 0 | false |
| library-checkout | artemis | 0.33 (1/3) | 2 | 0 | 0.85 (11/13) | n/a | 1.00 (3/3) | 4 | 24 | 6 | 0 | false |
| robot-rover | artemis | 1.00 (2/2) | 0 | 1 | 0.83 (10/12) | 1.00 (1/1) | 1.00 (3/3) | 7 | 29 | 4.142857 | 0 | false |
| state-machine | artemis | 1.00 (1/1) | 0 | 3 | 0.80 (4/5) | n/a | n/a | 5 | 22 | 4.4 | 0 | true |
| string-parsing | artemis | 0.67 (2/3) | 1 | 3 | 0.78 (7/9) | n/a | 0.50 (2/4) | 12 | 33 | 2.75 | 0 | true |

## Unwitnessed promises

### collections (artemis)
- UNWITNESSED immutability — "Immutability of inputs – you must not modify the supplied List<Purchase> nor any Purchase objects." — no rejection of a mutating call and no defensive-copy assertion
- UNWITNESSED no_mutation — "Immutability of inputs – you must not modify the supplied List<Purchase> nor any Purchase objects." — no assertion re-reads an argument after the call under test
- UNWITNESSED exception:NullPointerException — "Null handling – if either argument is null you must throw a NullPointerException." — no assertThrows for NullPointerException

### inheritance (artemis)
- UNWITNESSED immutability — "The classes are immutable – no setters are required." — no rejection of a mutating call and no defensive-copy assertion

### library-checkout (artemis)
- UNWITNESSED non_null_result — "The summarize method must never return null and must never modify the supplied list." — no assertNotNull on a result of the member under test, and no null rejection
- UNWITNESSED no_mutation — "The summarize method must never return null and must never modify the supplied list." — no assertion re-reads an argument after the call under test

### string-parsing (artemis)
- UNWITNESSED immutability — "Provide the constructor that receives an array of Entry objects and store them immutably." — no rejection of a mutating call and no defensive-copy assertion
