package de.tum.cit.aet.stepstatistics;

/**
 * Computes statistics over the daily step counts of a fitness tracker.
 */
public class StepStatistics {

    /**
     * Returns the average number of steps per day.
     *
     * @param steps the step count of each day, never null
     * @return the average rounded to two decimal places
     */
    public double average(int[] steps) {
        if (steps.length == 0) {
            return 0.0;
        }
        long total = 0;
        for (int day : steps) {
            total += day;
        }
        return Math.round(total * 100.0 / steps.length) / 100.0;
    }

    /**
     * Counts the days on which the goal is reached.
     *
     * @param steps the step count of each day, never null
     * @param goal  the daily step goal
     * @return the number of days that reach the goal
     */
    public int daysReachingGoal(int[] steps, int goal) {
        int days = 0;
        for (int day : steps) {
            if (day >= goal) {
                days++;
            }
        }
        return days;
    }

    /**
     * Returns the length of the longest run of consecutive days that reach the goal.
     *
     * @param steps the step count of each day, never null
     * @param goal  the daily step goal
     * @return the length of the longest streak
     */
    public int longestStreak(int[] steps, int goal) {
        int longest = 0;
        int current = 0;
        for (int day : steps) {
            if (day >= goal) {
                current++;
                if (current > longest) {
                    longest = current;
                }
            } else {
                current = 0;
            }
        }
        return longest;
    }
}
