package de.tum.cit.aet.exgenstructuredtextparsing;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.PathType;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;
import de.tum.in.test.api.util.ReflectionTestUtils;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Behavioural tests for {@link SummaryImpl}. The template does not provide this class, so the tests
 * will fail there until the student implements it.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class SummaryImplTest {

    @Test
    @StrictTimeout(1)
    void testEmpty() throws Exception {
        Entry[] entries = new Entry[0];
        Object summary = ReflectionTestUtils.newInstance("de.tum.cit.aet.exgenstructuredtextparsing.SummaryImpl", (Object) entries);
        int count = (int) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getEntryCount"));
        assertEquals(0, count, "Entry count should be 0 for empty array");
        @SuppressWarnings("unchecked")
        List<String> keys = (List<String>) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getKeys"));
        assertTrue(keys.isEmpty(), "Key list should be empty");
        String formatted = (String) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getFormatted"));
        assertEquals("Count: 0", formatted, "Formatted string for empty summary");
    }

    @Test
    @StrictTimeout(1)
    void testSingleEntry() throws Exception {
        Entry e = new Entry("name", "Alice");
        Object summary = ReflectionTestUtils.newInstance("de.tum.cit.aet.exgenstructuredtextparsing.SummaryImpl", (Object) new Entry[]{e});
        int count = (int) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getEntryCount"));
        assertEquals(1, count);
        @SuppressWarnings("unchecked")
        List<String> keys = (List<String>) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getKeys"));
        assertEquals(List.of("name"), keys);
        String formatted = (String) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getFormatted"));
        assertEquals("Count: 1\nname -> Alice", formatted);
    }

    @Test
    @StrictTimeout(1)
    void testMultipleDuplicateKeys() throws Exception {
        Entry e1 = new Entry("key", "v1");
        Entry e2 = new Entry("key", "v2");
        Object summary = ReflectionTestUtils.newInstance("de.tum.cit.aet.exgenstructuredtextparsing.SummaryImpl", (Object) new Entry[]{e1, e2});
        int count = (int) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getEntryCount"));
        assertEquals(2, count);
        @SuppressWarnings("unchecked")
        List<String> keys = (List<String>) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getKeys"));
        assertEquals(List.of("key", "key"), keys);
        String formatted = (String) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getFormatted"));
        assertEquals("Count: 2\nkey -> v1\nkey -> v2", formatted);
    }

    @Test
    @StrictTimeout(1)
    void testValuePreservesWhitespace() throws Exception {
        Entry e = new Entry("x", "  spaced  ");
        Object summary = ReflectionTestUtils.newInstance("de.tum.cit.aet.exgenstructuredtextparsing.SummaryImpl", (Object) new Entry[]{e});
        String formatted = (String) ReflectionTestUtils.invokeMethod(summary,
                ReflectionTestUtils.getMethod(summary, "getFormatted"));
        assertEquals("Count: 1\nx ->   spaced  ", formatted);
    }
}
