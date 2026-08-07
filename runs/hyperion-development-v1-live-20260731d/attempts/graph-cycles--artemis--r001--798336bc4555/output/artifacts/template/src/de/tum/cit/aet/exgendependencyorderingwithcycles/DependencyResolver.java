package de.tum.cit.aet.exgendependencyorderingwithcycles;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Provides the public API that students must implement.
 */
public class DependencyResolver {
    public DependencyResolver() {
        // no‑op constructor
    }

    /**
     * TODO S1: implement deterministic topological ordering for acyclic graphs respecting the alphabetical tie‑break.
     *
     * @param dependencies map of task identifiers to their direct prerequisites
     * @return an {@code Optional} containing the ordering, or {@code Optional.empty()} if a cycle exists
     */
    public Optional<List<String>> resolveOrder(Map<String, List<String>> dependencies) {
        // TODO S2: detect cycles and return Optional.empty() when a cycle exists.
        throw new UnsupportedOperationException("Not implemented");
    }
}
