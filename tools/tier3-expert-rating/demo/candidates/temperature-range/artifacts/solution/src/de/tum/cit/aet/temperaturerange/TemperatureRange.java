package de.tum.cit.aet.temperaturerange;

/**
 * A comfortable temperature range, given by a minimum and a maximum in degrees Celsius.
 */
public class TemperatureRange {

    private final double min;
    private final double max;

    public TemperatureRange(double min, double max) {
        this.min = min;
        this.max = max;
    }

    /**
     * Checks whether a temperature lies in this range.
     *
     * @param temperature the temperature in degrees Celsius
     * @return whether the temperature lies in the range
     */
    public boolean contains(double temperature) {
        return temperature >= min && temperature <= max;
    }

    /**
     * @return a one-line summary of this range
     */
    public String describe() {
        return "Range: " + min + " to " + max + " degrees Celsius";
    }
}
