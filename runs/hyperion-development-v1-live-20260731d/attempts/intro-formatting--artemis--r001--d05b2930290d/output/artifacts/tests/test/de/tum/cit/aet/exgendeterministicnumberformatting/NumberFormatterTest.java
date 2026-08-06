package de.tum.cit.aet.exgendeterministicnumberformatting;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Behavioral tests for {@link NumberFormatter} covering all partitions defined in the specification.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class NumberFormatterTest {

    @Test
    @StrictTimeout(1)
    void testPositiveRoundingDown() {
        NumberFormatter f = new NumberFormatter("kg");
        assertEquals("1.23 kg", f.format(1.234));
    }

    @Test
    @StrictTimeout(1)
    void testPositiveRoundingUp() {
        NumberFormatter f = new NumberFormatter("kg");
        assertEquals("1.24 kg", f.format(1.235));
    }

    @Test
    @StrictTimeout(1)
    void testNegativeRoundingDown() {
        NumberFormatter f = new NumberFormatter("kg");
        assertEquals("-1.23 kg", f.format(-1.234));
    }

    @Test
    @StrictTimeout(1)
    void testNegativeRoundingUp() {
        NumberFormatter f = new NumberFormatter("kg");
        assertEquals("-1.24 kg", f.format(-1.235));
    }

    @Test
    @StrictTimeout(1)
    void testNegativeSmallRoundedZero() {
        NumberFormatter f = new NumberFormatter("EUR");
        assertEquals("0.00 EUR", f.format(-0.004));
    }

    @Test
    @StrictTimeout(1)
    void testExactZero() {
        NumberFormatter f = new NumberFormatter("USD");
        assertEquals("0.00 USD", f.format(0.0));
    }

    @Test
    @StrictTimeout(1)
    void testUnitAppended() {
        NumberFormatter f = new NumberFormatter("USD");
        assertEquals("5.00 USD", f.format(5));
    }
}
