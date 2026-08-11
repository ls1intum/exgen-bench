package de.tum.cit.aet.exgenevensum;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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

    // The read below is outside @WhitelistPath("target"), so Ares denies it and no
    // test executes. That denial is the whole point of this fixture.
    @Test
    @StrictTimeout(1)
    void readsTheExpectedTotalsFromDisk() throws IOException {
        String expected = Files.readString(Path.of("/etc/exgen/expected-totals.txt"));
        assertEquals(Integer.parseInt(expected.trim()), evenSum.sumEven(new int[] { 2, 4 }));
    }
}
