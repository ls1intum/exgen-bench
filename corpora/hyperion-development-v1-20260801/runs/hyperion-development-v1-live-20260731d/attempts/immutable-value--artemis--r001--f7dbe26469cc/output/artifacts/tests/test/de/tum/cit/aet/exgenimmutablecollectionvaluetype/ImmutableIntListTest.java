package de.tum.cit.aet.exgenimmutablecollectionvaluetype;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class ImmutableIntListTest {

    @Test
    @StrictTimeout(1)
    void testConstructionCopiesInput() {
        List<Integer> src = new ArrayList<>(List.of(1, 2, 3));
        ImmutableIntList list = ImmutableIntList.of(src);
        // mutate source after construction
        src.add(4);
        // the immutable list must not see the new element
        assertEquals(List.of(1, 2, 3), list.asList(), "ImmutableIntList must copy input collection");
    }

    @Test
    @StrictTimeout(1)
    void testAsListUnmodifiable() {
        ImmutableIntList list = ImmutableIntList.of(List.of(10, 20));
        List<Integer> view = list.asList();
        assertThrows(UnsupportedOperationException.class, () -> view.add(30), "View must be unmodifiable");
        assertThrows(UnsupportedOperationException.class, () -> view.remove(0), "View must be unmodifiable");
        // reading works
        assertEquals(List.of(10, 20), view);
    }

    @Test
    @StrictTimeout(1)
    void testEqualityAndHashCode() {
        ImmutableIntList a = ImmutableIntList.of(List.of(5, 6, 7));
        ImmutableIntList b = ImmutableIntList.of(List.of(5, 6, 7));
        ImmutableIntList c = ImmutableIntList.of(List.of(7, 6, 5));
        assertEquals(a, b, "Lists with same content and order must be equal");
        assertEquals(a.hashCode(), b.hashCode(), "Equal instances must have same hashCode");
        assertNotEquals(a, c, "Order matters for equality");
        assertNotEquals(a, null, "Never equal to null");
        assertNotEquals(a, "some string", "Never equal to different type");
    }

    @Test
    @StrictTimeout(1)
    void testAddReturnsNewInstance() {
        ImmutableIntList original = ImmutableIntList.of(List.of(1, 2));
        ImmutableIntList added = original.add(3);
        // original unchanged
        assertEquals(List.of(1, 2), original.asList(), "Original must stay unchanged after add");
        // new instance contains appended value
        assertEquals(List.of(1, 2, 3), added.asList(), "Added instance must contain new element at the end");
    }

    @Test
    @StrictTimeout(1)
    void testRemoveReturnsNewInstance() {
        ImmutableIntList original = ImmutableIntList.of(List.of(1, 2, 1, 3));
        ImmutableIntList removed = original.remove(1);
        // original unchanged
        assertEquals(List.of(1, 2, 1, 3), original.asList(), "Original must stay unchanged after remove");
        // first occurrence removed
        assertEquals(List.of(2, 1, 3), removed.asList(), "Removed instance must omit first occurrence");
        // removing non‑present value yields equal instance
        ImmutableIntList unchanged = original.remove(99);
        assertEquals(original, unchanged, "Removing absent value must return equal instance");
    }

    @Test
    @StrictTimeout(1)
    void testAddHandlesExtremeValues() {
        ImmutableIntList empty = ImmutableIntList.of(List.of());
        ImmutableIntList withMin = empty.add(Integer.MIN_VALUE);
        assertEquals(List.of(Integer.MIN_VALUE), withMin.asList(), "R4: add must handle Integer.MIN_VALUE");
        ImmutableIntList withMax = empty.add(Integer.MAX_VALUE);
        assertEquals(List.of(Integer.MAX_VALUE), withMax.asList(), "R4: add must handle Integer.MAX_VALUE");
    }

    @Test
    @StrictTimeout(1)
    void testRemoveFromEmptyReturnsSame() {
        ImmutableIntList empty = ImmutableIntList.of(List.of());
        ImmutableIntList result = empty.remove(5);
        assertEquals(empty, result, "R5: removing from empty should return an equal instance");
    }

    // New tests for missing coverage
    @Test
    @StrictTimeout(1)
    void testConstructionCopiesEmptyInput() {
        List<Integer> src = new ArrayList<>();
        ImmutableIntList list = ImmutableIntList.of(src);
        // mutate source after construction
        src.add(42);
        assertEquals(List.of(), list.asList(), "ImmutableIntList must copy empty collection and ignore later mutations");
    }

    @Test
    @StrictTimeout(1)
    void testConstructionPreservesDuplicates() {
        List<Integer> src = new ArrayList<>(List.of(5, 5, 7, 5));
        ImmutableIntList list = ImmutableIntList.of(src);
        // ensure duplicates are retained in order
        assertEquals(List.of(5, 5, 7, 5), list.asList(), "ImmutableIntList must preserve duplicate values in order");
    }

    @Test
    @StrictTimeout(1)
    void testEqualityDifferentSize() {
        ImmutableIntList a = ImmutableIntList.of(List.of(1, 2, 3));
        ImmutableIntList b = ImmutableIntList.of(List.of(1, 2, 3, 4));
        assertNotEquals(a, b, "Lists of different sizes must not be equal");
    }

    // New tests for missing coverage
    @Test
    @StrictTimeout(1)
    void testConstructionRejectsNullCollection() {
        assertThrows(UnsupportedOperationException.class, () -> ImmutableIntList.of(null),
                "R1: of should reject null collection");
    }

    @Test
    @StrictTimeout(1)
    void testConstructionRejectsNullElement() {
        List<Integer> src = new ArrayList<>();
        src.add(null);
        assertThrows(UnsupportedOperationException.class, () -> ImmutableIntList.of(src),
                "R1: of should reject collection containing null elements");
    }

    @Test
    @StrictTimeout(1)
    void testHashCodeMatchesListHashCode() {
        List<Integer> src = List.of(1, 2, 3);
        ImmutableIntList a = ImmutableIntList.of(src);
        assertEquals(src.hashCode(), a.hashCode(), "R3: hashCode must be based on element order");
    }

    // New test for view immutability after add
    @Test
    @StrictTimeout(1)
    void testAsListViewUnchangedAfterAdd() {
        ImmutableIntList original = ImmutableIntList.of(List.of(1, 2));
        List<Integer> originalView = original.asList();
        ImmutableIntList added = original.add(3);
        List<Integer> addedView = added.asList();
        // original view must stay unchanged
        assertEquals(List.of(1, 2), originalView, "Original view must remain unchanged after add");
        // view of the new instance must reflect the added element
        assertEquals(List.of(1, 2, 3), addedView, "View of new instance must reflect added element");
    }

    // New test for remove first occurrence with duplicates and instance identity
    @Test
    @StrictTimeout(1)
    void testRemoveFirstOccurrenceWithDuplicates() {
        ImmutableIntList original = ImmutableIntList.of(List.of(1, 2, 1, 3, 1));
        ImmutableIntList removed = original.remove(1);
        // original must stay unchanged
        assertEquals(List.of(1, 2, 1, 3, 1), original.asList(), "Original must stay unchanged after remove");
        // only the first occurrence should be removed
        assertEquals(List.of(2, 1, 3, 1), removed.asList(), "Removed instance must omit only first occurrence of value");
        // a new instance must be returned when a removal occurs
        assertNotSame(original, removed, "Remove must return a new instance when element is present");
    }

}
