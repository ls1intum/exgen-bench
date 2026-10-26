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

    private final EvenSum subject = new EvenSum();

    @Test
    @StrictTimeout(1)
    void emptyArrayIsZero() {
        assertEquals(0, subject.sumEven(new int[] {}));
    }

    @Test
    @StrictTimeout(1)
    void negativeEvenValuesAreIncluded() {
        assertEquals(-6, subject.sumEven(new int[] { -2, -4, 7 }));
    }

    @Test
    @StrictTimeout(1)
    void positiveEvenValuesAreSummed() {
        assertEquals(6, subject.sumEven(new int[] { 1, 2, 3, 4 }));
    }
}
