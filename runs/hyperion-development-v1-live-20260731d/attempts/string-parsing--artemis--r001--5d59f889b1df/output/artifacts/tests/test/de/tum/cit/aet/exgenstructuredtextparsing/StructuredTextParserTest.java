package de.tum.cit.aet.exgenstructuredtextparsing;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.PathType;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Behavioural tests for {@code StructuredTextParser}. The template does not provide this class,
 * therefore the tests will fail there until the student implements it.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class StructuredTextParserTest {

    private Summary parse(String text) throws Exception {
        Class<?> parserCls = Class.forName("de.tum.cit.aet.exgenstructuredtextparsing.StructuredTextParser");
        Method parseMethod = parserCls.getMethod("parse", String.class);
        return (Summary) parseMethod.invoke(null, text);
    }

    @Test
    @StrictTimeout(1)
    void testNullInput() throws Exception {
        Summary s = parse(null);
        assertEquals(0, s.getEntryCount());
        assertTrue(s.getKeys().isEmpty());
        assertEquals("Count: 0", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testEmptyString() throws Exception {
        Summary s = parse("");
        assertEquals(0, s.getEntryCount());
        assertEquals("Count: 0", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testNormalLines() throws Exception {
        String input = "  name = Alice \nage=30\ncity = Berlin ";
        Summary s = parse(input);
        assertEquals(3, s.getEntryCount());
        assertEquals(List.of("name", "age", "city"), s.getKeys());
        assertEquals("Count: 3\nname -> Alice\nage -> 30\ncity -> Berlin", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testMalformedLinesIgnored() throws Exception {
        String input = "invalid line\nkeyOnly=   \n=missingKey\nvalid=ok";
        Summary s = parse(input);
        assertEquals(2, s.getEntryCount());
        assertEquals(List.of("keyOnly", "valid"), s.getKeys());
        assertEquals("Count: 2\nkeyOnly -> \nvalid -> ok", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testMultipleEqualsInValue() throws Exception {
        String input = "path=/usr/local/bin=extra"; // key=path, value="/usr/local/bin=extra"
        Summary s = parse(input);
        assertEquals(1, s.getEntryCount());
        assertEquals(List.of("path"), s.getKeys());
        assertEquals("Count: 1\npath -> /usr/local/bin=extra", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testKeyBecomesEmptyAfterTrim() throws Exception {
        String input = "   =value\n   =   \nvalid=ok";
        Summary s = parse(input);
        assertEquals(1, s.getEntryCount());
        assertEquals(List.of("valid"), s.getKeys());
        assertEquals("Count: 1\nvalid -> ok", s.getFormatted());
    }

    @Test
    @StrictTimeout(1)
    void testDuplicateKeysPreserved() throws Exception {
        String input = "a=1\na=2";
        Summary s = parse(input);
        assertEquals(2, s.getEntryCount(), "R5 – duplicate keys must be kept");
        assertEquals(List.of("a", "a"), s.getKeys(), "R5 – key list must contain duplicates in order");
        String expected = "Count: 2\na -> 1\na -> 2";
        assertEquals(expected, s.getFormatted(), "R5 – formatted output must contain both entries");
    }

    @Test
    @StrictTimeout(1)
    void testTrailingNewlineIgnored() throws Exception {
        String input = "a=1\nb=2\n"; // trailing newline creates empty line
        Summary s = parse(input);
        assertEquals(2, s.getEntryCount(), "R4: trailing empty line must be ignored");
        assertEquals(List.of("a", "b"), s.getKeys(), "R4: keys should correspond to the two valid lines only");
        assertEquals("Count: 2\na -> 1\nb -> 2", s.getFormatted(), "R4: formatted output must not contain a third line");
    }
}
