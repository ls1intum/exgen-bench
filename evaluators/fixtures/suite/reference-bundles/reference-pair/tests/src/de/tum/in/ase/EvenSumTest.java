package de.tum.in.ase;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class EvenSumTest {

    private final EvenSum evenSum = new EvenSum();

    @Test
    void sumsEvenValues() {
        assertEquals(6, evenSum.sumEven(new int[] { 1, 2, 3, 4 }));
    }

    @Test
    void returnsZeroForAnEmptyArray() {
        assertEquals(0, evenSum.sumEven(new int[] {}));
    }
}
