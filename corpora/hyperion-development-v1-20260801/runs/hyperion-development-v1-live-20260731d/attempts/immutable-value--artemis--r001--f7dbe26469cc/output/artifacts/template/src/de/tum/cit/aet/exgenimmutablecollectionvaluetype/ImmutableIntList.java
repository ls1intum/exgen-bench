package de.tum.cit.aet.exgenimmutablecollectionvaluetype;

import java.util.Collection;
import java.util.List;

/**
 * An immutable value type that stores an ordered collection of {@code int} values.
 * <p>
 * Students must implement the behavior according to the specification.
 */
public final class ImmutableIntList {
    // TODO S1: implement internal representation and constructor
    // TODO: internal representation
    // private final List<Integer> elements;

    private ImmutableIntList(/*TODO*/) {
        // TODO: store a defensive copy of the supplied list
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Creates an {@code ImmutableIntList} containing a copy of the supplied
     * collection's elements in iteration order.
     */
        // TODO S1: implement factory method that copies input collection
    public static ImmutableIntList of(Collection<Integer> elements) {
        // TODO: validate input, copy elements, create instance
        return null; // stub returns null to cause tests expecting exception to fail
    }

    /**
     * Returns an unmodifiable view of the elements stored in this list.
     */
        // TODO S2: return an unmodifiable view of the stored elements
    public List<Integer> asList() {
        // TODO: return unmodifiable view
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Returns a new {@code ImmutableIntList} containing all elements of this
     * instance followed by the supplied {@code value}.
     */
        // TODO S4: implement add that returns a new instance with the value appended
    public ImmutableIntList add(int value) {
        // TODO: create new instance with value appended
        throw new UnsupportedOperationException("Not implemented");
    }

    /**
     * Returns a new {@code ImmutableIntList} that contains all elements of this
     * instance except the first occurrence of {@code value}.
     */
        // TODO S5: implement remove that returns a new instance without the first occurrence of the value
    public ImmutableIntList remove(int value) {
        // TODO: create new instance without first occurrence of value
        throw new UnsupportedOperationException("Not implemented");
    }

    @Override
        // TODO S3: implement content-based equality
    public boolean equals(Object o) {
        // TODO: implement content equality
        throw new UnsupportedOperationException("Not implemented");
    }

    @Override
        // TODO S3: implement hashCode consistent with equals
    public int hashCode() {
        // TODO: implement hash code consistent with equals
        throw new UnsupportedOperationException("Not implemented");
    }
}
