package de.tum.cit.aet.eval.spike;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import de.tum.cit.aet.artemis.buildagent.dto.LocalCITestJobDTO;
import de.tum.cit.aet.artemis.buildagent.service.parser.TestResultXmlParser;

/**
 * Footprint proof: the vendored Artemis {@link TestResultXmlParser} (3 files, no Spring)
 * parses real Artemis surefire/JUnit reports with only Jackson + commons-lang3 on the classpath.
 * This is the parsing-parity signal for Tier-1 metrics #2 (executability) and #3 (oracle).
 */
class VendoredParserSmokeTest {

    private static String resource(String name) throws IOException {
        try (InputStream in = VendoredParserSmokeTest.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IOException("missing test resource: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void parsesAllSucceedReport() throws IOException {
        List<LocalCITestJobDTO> failed = new ArrayList<>();
        List<LocalCITestJobDTO> successful = new ArrayList<>();
        TestResultXmlParser.processTestResultFile(resource("/samples/all-succeed.xml"), failed, successful);

        System.out.println("[all-succeed] successful=" + successful.size() + " failed=" + failed.size());
        successful.forEach(t -> System.out.println("   PASS " + t.name()));
        assertEquals(4, successful.size(), "all four behaviour tests should pass");
        assertEquals(0, failed.size(), "no test should fail");
    }

    @Test
    void parsesAllFailReport() throws IOException {
        List<LocalCITestJobDTO> failed = new ArrayList<>();
        List<LocalCITestJobDTO> successful = new ArrayList<>();
        TestResultXmlParser.processTestResultFile(resource("/samples/all-fail.xml"), failed, successful);

        System.out.println("[all-fail] successful=" + successful.size() + " failed=" + failed.size());
        failed.forEach(t -> System.out.println("   FAIL " + t.name() + " -> " + t.testMessages()));
        assertEquals(0, successful.size(), "no test should pass");
        assertEquals(4, failed.size(), "all four behaviour tests should fail");
        assertTrue(failed.stream().anyMatch(t -> !t.testMessages().isEmpty()), "failures should carry messages");
    }
}
