# Step Statistics

Your fitness tracker records how many steps you walk each day and stores the counts of a period in an
array: `steps[0]` is the first day, `steps[1]` the second, and so on. You also set yourself a daily
step goal. In this exercise you complete the class `StepStatistics`, which turns the raw counts into
three numbers the tracker shows on its start screen.

Use loops to traverse the arrays. Do not use streams or library helper methods.

### Tasks

1. [task][Average steps per day](testAverageOfWeek,testAverageOfSingleDay,testAverageOfEmptyArray)
   Implement `average`, which returns the average number of steps per day, rounded to two decimal
   places. A period without any days has an average of `0.0`.

2. [task][Days that reach the goal](testDaysReachingGoal,testDayExactlyAtGoalCounts,testNoDayReachesGoal)
   Implement `daysReachingGoal`, which counts the days on which you reach the goal.

3. [task][Longest streak](testLongestStreak,testLongestStreakWithoutAnyGoalDay,testLongestStreakAtEnd)
   Implement `longestStreak`, which returns the length of the longest run of consecutive days on
   which you reach the goal. If you never reach the goal, the longest streak is `0`.
