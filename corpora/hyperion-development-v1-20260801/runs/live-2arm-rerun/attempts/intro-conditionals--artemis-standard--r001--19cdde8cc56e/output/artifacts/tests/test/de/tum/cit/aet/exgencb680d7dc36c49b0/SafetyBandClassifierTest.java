package de.tum.cit.aet.exgencb680d7dc36c49b0;

import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class SafetyBandClassifierTest {

    private final SafetyBandClassifier classifier = new SafetyBandClassifier();

    @Test
    @StrictTimeout(1)
    void testBelowLowerBound() {
        assertEquals("BELOW", classifier.classify(-12.5));
    }

    @Test
    @StrictTimeout(1)
    void testExactlyLowerBound() {
        assertEquals("NORMAL", classifier.classify(SafetyBandClassifier.LOWER_BOUND));
    }

    @Test
    @StrictTimeout(1)
    void testBetweenBounds() {
        assertEquals("NORMAL", classifier.classify(45.7));
    }

    @Test
    @StrictTimeout(1)
    void testExactlyUpperBound() {
        assertEquals("NORMAL", classifier.classify(SafetyBandClassifier.UPPER_BOUND));
    }

    @Test
    @StrictTimeout(1)
    void testAboveUpperBound() {
        assertEquals("ABOVE", classifier.classify(123.4));
    }
}
