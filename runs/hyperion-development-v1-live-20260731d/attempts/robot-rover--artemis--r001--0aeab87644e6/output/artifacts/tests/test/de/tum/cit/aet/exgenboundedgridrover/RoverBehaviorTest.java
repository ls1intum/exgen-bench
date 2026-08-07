package de.tum.cit.aet.exgenboundedgridrover;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;

/**
 * Behavioral tests for {@link Rover} covering all partitions of the execution script.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class RoverBehaviorTest {

    private Rover createRover(int width, int height, Set<Point> obstacles,
                             int startX, int startY, Direction startDir) {
        return new Rover(width, height, obstacles, startX, startY, startDir);
    }

    @Test
    @StrictTimeout(1)
    void testEmptyScriptSuccess() {
        Rover rover = createRover(5, 5, Collections.emptySet(), 2, 2, Direction.NORTH);
        ExecutionResult result = rover.execute("");
        assertTrue(result.isSuccess(), "Empty script should succeed");
        assertEquals(2, result.getX());
        assertEquals(2, result.getY());
        assertEquals(Direction.NORTH, result.getDirection());
        assertNull(result.getErrorMessage());
    }

    @Test
    @StrictTimeout(1)
    void testTurnOnlySuccess() {
        Rover rover = createRover(5, 5, Collections.emptySet(), 0, 0, Direction.NORTH);
        // L R R L L -> sequence: N->W->N->E->N->W
        ExecutionResult result = rover.execute("LRRLL");
        assertTrue(result.isSuccess());
        assertEquals(0, result.getX());
        assertEquals(0, result.getY());
        assertEquals(Direction.WEST, result.getDirection());
    }

    @Test
    @StrictTimeout(1)
    void testMoveInsideBoundsSuccess() {
        Rover rover = createRover(5, 5, Collections.emptySet(), 0, 0, Direction.NORTH);
        ExecutionResult result = rover.execute("MMRMM");
        assertTrue(result.isSuccess());
        assertEquals(2, result.getX());
        assertEquals(2, result.getY());
        assertEquals(Direction.EAST, result.getDirection());
    }

    @Test
    @StrictTimeout(1)
    void testInvalidCommandStopsExecution() {
        Rover rover = createRover(5, 5, Collections.emptySet(), 0, 0, Direction.NORTH);
        ExecutionResult result = rover.execute("MXL"); // X is invalid, should stop after M
        assertFalse(result.isSuccess());
        assertEquals("Invalid command", result.getErrorMessage());
        // after first M, position (0,1), direction still NORTH
        assertEquals(0, result.getX());
        assertEquals(1, result.getY());
        assertEquals(Direction.NORTH, result.getDirection());
    }

    @Test
    @StrictTimeout(1)
    void testOutOfBoundsStopsExecution() {
        Rover rover = createRover(3, 3, Collections.emptySet(), 0, 0, Direction.NORTH);
        ExecutionResult result = rover.execute("MMM"); // third move out of bounds
        assertFalse(result.isSuccess());
        assertEquals("Out of bounds", result.getErrorMessage());
        // after two moves, at (0,2)
        assertEquals(0, result.getX());
        assertEquals(2, result.getY());
        assertEquals(Direction.NORTH, result.getDirection());
    }

    @Test
    @StrictTimeout(1)
    void testObstacleEncounteredStopsExecution() {
        Set<Point> obstacles = new HashSet<>();
        obstacles.add(new Point(0, 2));
        Rover rover = createRover(5, 5, obstacles, 0, 0, Direction.NORTH);
        ExecutionResult result = rover.execute("MM"); // second move hits obstacle
        assertFalse(result.isSuccess());
        assertEquals("Obstacle encountered", result.getErrorMessage());
        // after first move, at (0,1)
        assertEquals(0, result.getX());
        assertEquals(1, result.getY());
        assertEquals(Direction.NORTH, result.getDirection());
    }

    @Test
    @StrictTimeout(1)
    void testNullScriptThrows() {
        Rover rover = createRover(5, 5, Collections.emptySet(), 0, 0, Direction.NORTH);
        assertThrows(IllegalArgumentException.class, () -> rover.execute(null));
    }
}
