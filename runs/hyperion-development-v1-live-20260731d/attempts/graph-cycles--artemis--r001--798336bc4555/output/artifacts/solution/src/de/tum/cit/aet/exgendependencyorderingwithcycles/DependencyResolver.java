package de.tum.cit.aet.exgendependencyorderingwithcycles;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Resolves a deterministic execution order for a set of tasks that may depend on each other.
 * <p>
 * The algorithm implements a topological sort with an alphabetical tie‑break. If the
 * dependency graph contains a directed cycle, {@link #resolveOrder(Map)} returns an empty
 * {@link Optional} to signal that no valid ordering exists.
 * </p>
 */
public class DependencyResolver {

    /**
     * Creates a new {@code DependencyResolver}. The constructor performs no observable work.
     */
    public DependencyResolver() {
        // no‑op constructor
    }

    /**
     * Returns a deterministic ordering of the given tasks respecting their direct prerequisites.
     * <p>
     * The returned list contains every task identifier exactly once and each task appears
     * after all of its direct prerequisites. When more than one task is eligible at a step,
     * the alphabetically earliest identifier (according to {@link String#compareTo(String)})
     * is chosen.
     * </p>
     *
     * @param dependencies a map where each key is a task identifier and the associated value
     *                     is the list of its direct prerequisites (may be empty). All identifiers
     *                     appearing either as a key or as a prerequisite are guaranteed to be
     *                     present as a key in the map.
     * @return an {@link Optional} containing the ordering if the graph is acyclic, or
     *         {@link Optional#empty()} if a directed cycle is detected.
     */
    public Optional<List<String>> resolveOrder(Map<String, List<String>> dependencies) {
        // Defensive copy to avoid mutating the input map
        Map<String, Set<String>> prereqMap = new HashMap<>();
        for (Map.Entry<String, List<String>> e : dependencies.entrySet()) {
            prereqMap.put(e.getKey(), new HashSet<>(e.getValue()));
        }

        // Build reverse adjacency: for each task, which tasks depend on it
        Map<String, Set<String>> dependents = new HashMap<>();
        for (String task : prereqMap.keySet()) {
            dependents.put(task, new HashSet<>());
        }
        for (Map.Entry<String, Set<String>> e : prereqMap.entrySet()) {
            String task = e.getKey();
            for (String pre : e.getValue()) {
                dependents.get(pre).add(task);
            }
        }

        // Priority queue for deterministic alphabetical selection of eligible tasks
        PriorityQueue<String> ready = new PriorityQueue<>();
        for (Map.Entry<String, Set<String>> e : prereqMap.entrySet()) {
            if (e.getValue().isEmpty()) {
                ready.add(e.getKey());
            }
        }

        List<String> order = new ArrayList<>();
        while (!ready.isEmpty()) {
            String cur = ready.poll();
            order.add(cur);
            // Remove cur from prerequisites of its dependents
            for (String dep : dependents.get(cur)) {
                Set<String> preSet = prereqMap.get(dep);
                preSet.remove(cur);
                if (preSet.isEmpty()) {
                    ready.add(dep);
                }
            }
        }

        // If we placed all tasks, graph was acyclic
        if (order.size() == prereqMap.size()) {
            return Optional.of(order);
        }
        // Cycle detected
        return Optional.empty();
    }
}
