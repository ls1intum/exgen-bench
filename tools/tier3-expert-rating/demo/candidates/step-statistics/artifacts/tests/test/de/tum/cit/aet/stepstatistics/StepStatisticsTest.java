package de.tum.cit.aet.stepstatistics;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StepStatisticsTest {

    private final StepStatistics statistics = new StepStatistics();

    @Test
    void testAverageOfWeek() {
        int[] steps = { 6000, 8000, 7000, 9000 };
        assertEquals(7500.0, statistics.average(steps),
                "average() should return 7500.0 for the steps [6000, 8000, 7000, 9000].");
    }

    @Test
    void testAverageOfSingleDay() {
        assertEquals(4321.0, statistics.average(new int[] { 4321 }),
                "The average of a single day should be the step count of that day.");
    }

    @Test
    void testAverageOfEmptyArray() {
        assertEquals(0.0, statistics.average(new int[] {}));
    }

    @Test
    void testDaysReachingGoal() {
        int[] steps = { 12000, 4000, 11000, 9999, 15000 };
        assertEquals(3, statistics.daysReachingGoal(steps, 10000),
                "With a goal of 10000, three of the days [12000, 4000, 11000, 9999, 15000] reach the goal.");
    }

    @Test
    void testDayExactlyAtGoalCounts() {
        int[] steps = { 10000, 9000 };
        assertEquals(1, statistics.daysReachingGoal(steps, 10000),
                "A day with exactly 10000 steps should count as reaching a goal of 10000.");
    }

    @Test
    void testNoDayReachesGoal() {
        int[] steps = { 1000, 2000, 3000 };
        assertEquals(0, statistics.daysReachingGoal(steps, 5000),
                "No day of [1000, 2000, 3000] reaches a goal of 5000, so the result should be 0.");
    }

    @Test
    void testLongestStreak() {
        int[] steps = { 11000, 12000, 3000, 10500, 10200, 10100, 2000 };
        assertEquals(3, statistics.longestStreak(steps, 10000),
                "The longest streak of days reaching 10000 steps in [11000, 12000, 3000, 10500, 10200, 10100, 2000] is 3 days long.");
    }

    @Test
    void testLongestStreakWithoutAnyGoalDay() {
        int[] steps = { 1000, 2000, 3000 };
        assertEquals(0, statistics.longestStreak(steps, 5000),
                "If no day reaches the goal, the longest streak should be 0.");
    }

    @Test
    void testLongestStreakAtEnd() {
        int[] steps = { 1000, 11000, 12000 };
        assertEquals(2, statistics.longestStreak(steps, 10000),
                "A streak at the end of the array should be counted: [1000, 11000, 12000] has a streak of 2 days.");
    }
}
