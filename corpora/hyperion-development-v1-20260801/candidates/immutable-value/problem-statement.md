# Immutable integer list

We want a value type that stores an ordered collection of `int` values and never changes after it has been created. Your implementation must respect the following contracts:

* **Construction copies the supplied collection** – `ImmutableIntList.of(Collection<Integer>)` must create a new instance that contains a copy of the elements in iteration order. The original collection may be mutated afterwards without influencing the created list.
* **The exposed view is read‑only** – `asList()` returns a `List<Integer>` that reflects the current content of the instance but throws `UnsupportedOperationException` for every mutating operation.
* **Equality is based on content and order** – two instances are equal iff they contain exactly the same integers in the same order. `hashCode()` must be consistent with this definition.
* **Derived operations return fresh instances** – `add(int)` returns a new list with the supplied value appended, leaving the original unchanged. `remove(int)` returns a new list without the *first* occurrence of the supplied value; if the value is absent the returned list is equal to the original.

The class must never contain `null` elements.

## Public API
| Member | Signature |
|--------|-----------|
| factory | `public static ImmutableIntList of(Collection<Integer> elements)` |
| view | `public List<Integer> asList()` |
| add | `public ImmutableIntList add(int value)` |
| remove | `public ImmutableIntList remove(int value)` |
| equals | `public boolean equals(Object o)` |
| hashCode | `public int hashCode()` |

All members are `public` and the class is declared `final`.

## Worked example
```java
List<Integer> source = new ArrayList<>(List.of(2, 4, 6));
ImmutableIntList list1 = ImmutableIntList.of(source);
source.add(8);                     // source is mutated
System.out.println(list1.asList()); // prints [2, 4, 6]

ImmutableIntList list2 = list1.add(10);
System.out.println(list1.asList()); // still [2, 4, 6]
System.out.println(list2.asList()); // [2, 4, 6, 10]

ImmutableIntList list3 = list2.remove(4);
System.out.println(list3.asList()); // [2, 6, 10]
ImmutableIntList list4 = list3.remove(99); // value not present
System.out.println(list4.equals(list3)); // true
```
The view returned by `asList()` cannot be modified:
```java
List<Integer> view = list3.asList();
view.add(5); // throws UnsupportedOperationException
```

## Tasks
[task][Construction copies input](<testid>16</testid>,<testid>10</testid>,<testid>18</testid>,<testid>20</testid>,<testid>12</testid>)
Implement the factory method so that it copies the supplied collection and stores the elements internally.

[task][Unmodifiable view of asList](<testid>15</testid>,<testid>8</testid>)
Provide an `asList()` implementation that returns an unmodifiable view of the stored elements.

[task][Content based equality and hashCode](<testid>7</testid>,<testid>17</testid>,<testid>19</testid>)
Implement `equals` and `hashCode` so that two instances compare equal exactly when they contain the same integers in the same order.

[task][Add returns new instance](<testid>13</testid>,<testid>14</testid>)
Implement `add(int)` to create a new `ImmutableIntList` with the given value appended, leaving the original untouched.

[task][Remove returns new instance](<testid>9</testid>,<testid>21</testid>,<testid>11</testid>)
Implement `remove(int)` to create a new `ImmutableIntList` without the first occurrence of the given value; if the value is absent return an instance equal to the original.