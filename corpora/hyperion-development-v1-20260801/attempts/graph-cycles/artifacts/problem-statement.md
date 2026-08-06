# Task Dependency Ordering

We want to compute a valid execution order for a set of tasks that may depend on each other. You are given a map where each key is a task identifier (a non‑empty string) and the associated list contains the identifiers of its direct prerequisites. Your job is to implement a deterministic algorithm that:

* Returns a list containing **every** task exactly once, with each task appearing **after** all of its direct prerequisites, **if** the dependency graph has no cycles.
* Breaks ties alphabetically – when several tasks are ready to be placed (all their prerequisites are already in the output), you must choose the task whose identifier is smallest according to `String.compareTo`.
* Returns `Optional.empty()` when the graph contains any directed cycle.

The input map is guaranteed to contain an entry for every identifier that appears either as a key or as a prerequisite. No further validation is required.

## Public API

```java
package de.tum.cit.aet.exgendependencyorderingwithcycles;

import java.util.List;
import java.util.Map;
import java.util.Optional;

public class DependencyResolver {
    public DependencyResolver() { }
    public Optional<List<String>> resolveOrder(Map<String, List<String>> dependencies) { /* TODO */ }
}
```

*The constructor does nothing observable.*
*`resolveOrder` receives the dependency map and returns an `Optional` containing the deterministic ordering, or `Optional.empty()` if a cycle exists.*

## Worked Example

```text
Input:
{
    "A": [],
    "B": ["A"],
    "C": ["A"],
    "D": ["B", "C"]
}
```
* After placing **A**, both **B** and **C** are eligible. Because "B" < "C" alphabetically, **B** is placed first, then **C**, and finally **D**.

Result: `Optional.of(["A", "B", "C", "D"])`.

If the input contains a cycle, e.g. `{ "X": ["Y"], "Y": ["Z"], "Z": ["X"] }`, the method must return `Optional.empty()`.

## Tasks

[task][Produce ordering for acyclic graphs respecting alphabetical tie‑break](<testid>44</testid>,<testid>41</testid>,<testid>43</testid>,<testid>40</testid>)
Implement `DependencyResolver.resolveOrder` so that it returns a deterministic ordering that respects all prerequisites and uses alphabetical tie‑break when several tasks are ready.

[task][Detect cycles and return an empty optional](<testid>42</testid>,<testid>39</testid>)
Implement `DependencyResolver.resolveOrder` so that it returns `Optional.empty()` when the prerequisite graph contains any directed cycle.