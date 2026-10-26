package de.tum.cit.aet.temperaturerange;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TemperatureRangeTest {

    private final TemperatureRange range = new TemperatureRange(18.0, 24.0);

    @Test
    void testContainsValueInside() {
        assertTrue(range.contains(21.5),
                "21.5 lies between 18.0 and 24.0, so contains(21.5) should return true.");
    }

    @Test
    void testContainsOnlyValuesInside() {
        double[] readings = { 10.0, 20.0, 30.0 };
        int inside = 0;
        for (double reading : readings) {
            if (range.contains(reading)) {
                inside++;
            }
        }
        assertEquals(1, inside,
                "Of the readings 10.0, 20.0 and 30.0, only 20.0 lies in the range from 18.0 to 24.0.");
    }

    @Test
    void test1() {
        assertTrue(range.contains(24.0));
    }

    @Test
    void testDescribe() {
        assertEquals("Range: 18.0 to 24.0 degrees Celsius", range.describe(),
                "describe() should summarise the range from 18.0 to 24.0.");
    }

    @Test
    void test2() {
        assertEquals("Range: -5.5 to 3.0 degrees Celsius", new TemperatureRange(-5.5, 3.0).describe());
    }
}
