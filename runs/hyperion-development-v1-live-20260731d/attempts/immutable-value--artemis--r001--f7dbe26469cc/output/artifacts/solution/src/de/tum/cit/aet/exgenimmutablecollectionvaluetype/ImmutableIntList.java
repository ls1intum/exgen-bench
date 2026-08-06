package de.tum.cit.aet.exgenimmutablecollectionvaluetype;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * An immutable value type that stores an ordered collection of {@code int} values.
 * <p>
 * Instances are created via {@link #of(Collection)} which copies the supplied
 * collection. All mutating operations return a new {@code ImmutableIntList}
 * instance leaving the original unchanged.
 */
public final class ImmutableIntList {
    private final List<Integer> elements;

    private ImmutableIntList(List<Integer> elements) {
        // The list is already a defensive copy and contains no nulls.
        this.elements = Collections.unmodifiableList(elements);
    }

    /**
     * Creates an {@code ImmutableIntList} containing a copy of the supplied
     * collection's elements in iteration order.
     *
     * @param elements the source collection, must not be {@code null} and must not contain {@code null} elements
     * @return a new immutable list
     * @throws UnsupportedOperationException if {@code elements} is {@code null} or contains a {@code null} element
     */
    public static ImmutableIntList of(Collection<Integer> elements) {
        if (elements == null) {
            throw new UnsupportedOperationException("Input collection must not be null");
        }
        List<Integer> copy = new ArrayList<>(elements.size());
        for (Integer e : elements) {
            if (e == null) {
                throw new UnsupportedOperationException("Collection must not contain null elements");
            }
            copy.add(e);
        }
        return new ImmutableIntList(copy);
    }

    /**
     * Returns an unmodifiable view of the elements stored in this list.
     *
     * @return an unmodifiable {@link List} reflecting the current state
     */
    public List<Integer> asList() {
        return elements;
    }

    /**
     * Returns a new {@code ImmutableIntList} containing all elements of this
     * instance followed by the supplied {@code value}.
     *
     * @param value the value to append
     * @return a new immutable list with the value appended
     */
    public ImmutableIntList add(int value) {
        List<Integer> newElements = new ArrayList<>(elements);
        newElements.add(value);
        return new ImmutableIntList(newElements);
    }

    /**
     * Returns a new {@code ImmutableIntList} that contains all elements of this
     * instance except the first occurrence of {@code value}. If the value is not
     * present, the returned instance is equal to this one.
     *
     * @param value the value to remove
     * @return a new immutable list with the first occurrence removed, or this instance if the value is absent
     */
    public ImmutableIntList remove(int value) {
        List<Integer> newElements = new ArrayList<>(elements.size());
        boolean removed = false;
        for (Integer e : elements) {
            if (!removed && e == value) {
                removed = true; // skip this element
                continue;
            }
            newElements.add(e);
        }
        if (!removed) {
            return this; // no change
        }
        return new ImmutableIntList(newElements);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ImmutableIntList)) return false;
        ImmutableIntList that = (ImmutableIntList) o;
        return elements.equals(that.elements);
    }

    @Override
    public int hashCode() {
        return elements.hashCode();
    }
}
