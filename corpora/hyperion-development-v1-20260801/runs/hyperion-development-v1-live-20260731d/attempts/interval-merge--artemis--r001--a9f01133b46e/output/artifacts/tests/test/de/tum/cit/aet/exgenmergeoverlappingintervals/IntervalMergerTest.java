package de.tum.cit.aet.exgenmergeoverlappingintervals;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.PathType;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assertions.fail;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class IntervalMergerTest {

    private Method mergeMethod;

    @BeforeEach
    void setUp() throws Exception {
        try {
            Class<?> clazz = Class.forName("de.tum.cit.aet.exgenmergeoverlappingintervals.IntervalMerger");
            mergeMethod = clazz.getMethod("merge", List.class);
        } catch (ClassNotFoundException e) {
            fail("IntervalMerger class not found");
        }
    }

    // Helper to invoke the static merge method via reflection
    @SuppressWarnings("unchecked")
    private List<Interval> merge(List<Interval> intervals) throws Exception {
        Object result = mergeMethod.invoke(null, intervals);
        return (List<Interval>) result;
    }

    @Test
    @StrictTimeout(1)
    void testOverlappingMerging() throws Exception {
        List<Interval> input = Arrays.asList(
                new Interval(15, 18),
                new Interval(1, 3),
                new Interval(2, 6),
                new Interval(8, 10)
        );
        List<Interval> merged = merge(input);
        assertEquals(3, merged.size(), "Expected three merged intervals");
        assertEquals(1, merged.get(0).getStart());
        assertEquals(6, merged.get(0).getEnd());
        assertEquals(8, merged.get(1).getStart());
        assertEquals(10, merged.get(1).getEnd());
        assertEquals(15, merged.get(2).getStart());
        assertEquals(18, merged.get(2).getEnd());
    }

    @Test
    @StrictTimeout(1)
    void testTouchingMerging() throws Exception {
        List<Interval> input = Arrays.asList(
                new Interval(1, 2),
                new Interval(2, 4),
                new Interval(5, 7)
        );
        List<Interval> merged = merge(input);
        assertEquals(2, merged.size());
        assertEquals(1, merged.get(0).getStart());
        assertEquals(4, merged.get(0).getEnd());
        assertEquals(5, merged.get(1).getStart());
        assertEquals(7, merged.get(1).getEnd());
    }

    @Test
    @StrictTimeout(1)
    void testUnsortedTouchingMerging() throws Exception {
        List<Interval> input = Arrays.asList(
                new Interval(5, 7),
                new Interval(1, 2),
                new Interval(2, 4)
        );
        List<Interval> merged = merge(input);
        assertEquals(2, merged.size());
        assertEquals(1, merged.get(0).getStart());
        assertEquals(4, merged.get(0).getEnd());
        assertEquals(5, merged.get(1).getStart());
        assertEquals(7, merged.get(1).getEnd());
    }

    @Test
    @StrictTimeout(1)
    void testContainedAndEmpty() throws Exception {
        // Contained intervals
        List<Interval> input = Arrays.asList(
                new Interval(1, 10),
                new Interval(2, 5),
                new Interval(6, 9)
        );
        List<Interval> merged = merge(input);
        assertEquals(1, merged.size());
        assertEquals(1, merged.get(0).getStart());
        assertEquals(10, merged.get(0).getEnd());

        // Empty input
        List<Interval> empty = Collections.emptyList();
        List<Interval> mergedEmpty = merge(empty);
        assertTrue(mergedEmpty.isEmpty(), "Merging empty list should return empty list");
    }

    @Test
    @StrictTimeout(1)
    void testNullListException() {
        Exception thrown = assertThrows(Exception.class, () -> merge(null));
        // The reflective invocation wraps the IllegalArgumentException in an InvocationTargetException.
        Throwable cause = thrown instanceof java.lang.reflect.InvocationTargetException
                ? ((java.lang.reflect.InvocationTargetException) thrown).getCause()
                : thrown;
        assertTrue(cause instanceof IllegalArgumentException, "Expected IllegalArgumentException as cause");
        assertNotNull(cause.getMessage());
    }

    @Test
    @StrictTimeout(1)
    void testOnlyNullElementsEmpty() throws Exception {
        List<Interval> input = Arrays.asList(null, null);
        List<Interval> merged = merge(input);
        assertTrue(merged.isEmpty(), "Merging list of only nulls should return empty list");
    }

    @Test
    @StrictTimeout(1)
    void testSortedNonOverlappingUnchanged() throws Exception {
        List<Interval> input = Arrays.asList(
                new Interval(1, 2),
                new Interval(3, 5),
                new Interval(6, 8)
        );
        List<Interval> merged = merge(input);
        assertEquals(3, merged.size());
        for (int i = 0; i < input.size(); i++) {
            assertEquals(input.get(i).getStart(), merged.get(i).getStart());
            assertEquals(input.get(i).getEnd(), merged.get(i).getEnd());
        }
    }

    @Test
    @StrictTimeout(1)
    void testNullElementsAndDeterminism() throws Exception {
        List<Interval> input = new ArrayList<>();
        input.add(null);
        input.add(new Interval(1, 3));
        input.add(null);
        input.add(new Interval(2, 4));
        List<Interval> first = merge(input);
        List<Interval> second = merge(input);
        assertEquals(first.size(), second.size());
        for (int i = 0; i < first.size(); i++) {
            assertEquals(first.get(i).getStart(), second.get(i).getStart());
            assertEquals(first.get(i).getEnd(), second.get(i).getEnd());
        }
    }
}

