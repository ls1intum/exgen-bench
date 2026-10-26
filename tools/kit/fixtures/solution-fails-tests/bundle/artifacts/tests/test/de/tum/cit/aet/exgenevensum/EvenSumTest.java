package de.tum.cit.aet.exgenevensum;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class EvenSumTest {

    private final EvenSum evenSum = new EvenSum();

    @Test
    @StrictTimeout(1)
    void sumsEvenValues() {
        assertEquals(6, evenSum.sumEven(new int[] { 1, 2, 3, 4 }));
    }

    @Test
    @StrictTimeout(1)
    void returnsZeroForAnEmptyArray() {
        assertEquals(0, evenSum.sumEven(new int[] {}));
    }

    @Test
    @StrictTimeout(1)
    void handlesNegativeEvenValues() {
        assertEquals(-6, evenSum.sumEven(new int[] { -2, -4, 7 }));
    }
}
