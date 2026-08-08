package de.tum.in.ase;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;

class EvenSumTest {

    private final EvenSum evenSum = new EvenSum();

    @Test
    void sumsEvenValues() {
        assertEquals(6, evenSum.sumEven(new int[] { 1, 2, 3, 4 }));
    }

    @Test
    void readsTheExpectedTotalsFromDisk() throws IOException {
        String expected = Files.readString(Path.of("/etc/exgen/expected-totals.txt"));
        assertEquals(Integer.parseInt(expected.trim()), evenSum.sumEven(new int[] { 2, 4 }));
    }
}
