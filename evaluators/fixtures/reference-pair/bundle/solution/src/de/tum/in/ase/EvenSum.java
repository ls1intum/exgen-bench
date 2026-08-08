package de.tum.in.ase;

/**
 * Sums the even elements of an array.
 */
public class EvenSum {

    /**
     * Returns the sum of every even element of the given array.
     *
     * @param values the values to inspect, never null
     * @return the sum of the even values, or 0 when there is none
     */
    public int sumEven(int[] values) {
        int accumulator = 0;
        for (int index = 0; index < values.length; index++) {
            int current = values[index];
            if (current % 2 == 0) {
                accumulator += current;
            }
        }
        return accumulator;
    }
}
