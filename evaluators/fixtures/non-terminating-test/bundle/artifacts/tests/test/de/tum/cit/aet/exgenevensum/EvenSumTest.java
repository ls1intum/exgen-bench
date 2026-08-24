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

    // Deliberately no @StrictTimeout: this fixture exists to prove that a build
    // which never returns is infrastructure, not a quality verdict. Ares would
    // otherwise convert the hang into an ordinary failing test.
    @Test
    void spinsForever() {
        int total = 0;
        while (true) {
            total += evenSum.sumEven(new int[] { 2 });
        }
    }
}
