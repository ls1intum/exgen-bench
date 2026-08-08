package de.tum.in.ase;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class EvenSumTest {

    private final EvenSum subject = new EvenSum();

    @Test
    void emptyArrayIsZero() {
        assertEquals(0, subject.sumEven(new int[] {}));
    }

    @Test
    void negativeEvenValuesAreIncluded() {
        assertEquals(-6, subject.sumEven(new int[] { -2, -4, 7 }));
    }

    @Test
    void positiveEvenValuesAreSummed() {
        assertEquals(6, subject.sumEven(new int[] { 1, 2, 3, 4 }));
    }
}
