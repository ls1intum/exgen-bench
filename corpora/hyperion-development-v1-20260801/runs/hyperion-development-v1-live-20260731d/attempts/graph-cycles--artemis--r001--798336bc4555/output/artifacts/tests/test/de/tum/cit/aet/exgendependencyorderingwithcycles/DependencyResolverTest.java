package de.tum.cit.aet.exgendependencyorderingwithcycles;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import org.junit.jupiter.api.Test;

import java.util.*;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class DependencyResolverTest {

    @Test
    @StrictTimeout(1)
    void testResolveOrderAcyclicSimple() {
        Map<String, List<String>> deps = new HashMap<>();
        deps.put("A", List.of());
        deps.put("B", List.of("A"));
        deps.put("C", List.of("A"));
        deps.put("D", List.of("B", "C"));

        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertTrue(result.isPresent(), "Expected a valid ordering for an acyclic graph");
        List<String> expected = List.of("A", "B", "C", "D");
        assertEquals(expected, result.get(), "Ordering does not respect alphabetical tie‑break");
    }

    @Test
    @StrictTimeout(1)
    void testResolveOrderTieBreak() {
        Map<String, List<String>> deps = new HashMap<>();
        deps.put("B", List.of());
        deps.put("A", List.of());
        deps.put("C", List.of("A", "B"));

        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertTrue(result.isPresent(), "Expected a valid ordering for an acyclic graph");
        List<String> expected = List.of("A", "B", "C"); // A < B alphabetically
        assertEquals(expected, result.get(), "Alphabetical tie‑break not applied correctly");
    }

    @Test
    @StrictTimeout(1)
    void testResolveOrderCycle() {
        Map<String, List<String>> deps = new HashMap<>();
        deps.put("X", List.of("Y"));
        deps.put("Y", List.of("Z"));
        deps.put("Z", List.of("X"));

        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertFalse(result.isPresent(), "Expected empty Optional for a graph containing a cycle");
    }

    @Test
    @StrictTimeout(1)
    void testResolveOrderEmptyGraph() {
        Map<String, List<String>> deps = new HashMap<>(); // empty map
        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertTrue(result.isPresent(), "Expected a present Optional for empty dependency map");
        assertEquals(List.of(), result.get(), "Ordering for empty graph should be empty list");
    }

    @Test
    @StrictTimeout(1)
    void testResolveOrderSelfDependency() {
        Map<String, List<String>> deps = new HashMap<>();
        deps.put("A", List.of("A")); // self‑dependency creates a cycle
        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertFalse(result.isPresent(), "Self‑dependency should be detected as a cycle");
    }

    @Test
    @StrictTimeout(1)
    void testResolveOrderLaterTieBreak() {
        Map<String, List<String>> deps = new HashMap<>();
        deps.put("A", List.of());
        deps.put("B", List.of());
        deps.put("C", List.of("A"));
        deps.put("D", List.of("B"));
        deps.put("E", List.of("C", "D"));
        DependencyResolver resolver = new DependencyResolver();
        Optional<List<String>> result = resolver.resolveOrder(deps);
        assertTrue(result.isPresent(), "Expected a valid ordering for acyclic graph with later tie‑break");
        List<String> expected = List.of("A", "B", "C", "D", "E");
        assertEquals(expected, result.get(), "Alphabetical tie‑break not applied at later step");
    }
}

