package de.tum.cit.aet.exgenboundedgridrover;

import java.util.Objects;
import java.util.Set;

/**
 * Represents a rover that can move on a bounded rectangular grid while avoiding obstacles.
 */
public class Rover {
    private final int width;
    private final int height;
    private final Set<Point> obstacles;
    private int x;
    private int y;
    private Direction direction;

    /**
     * Creates a new rover.
     *
     * @param width     grid width, must be positive
     * @param height    grid height, must be positive
     * @param obstacles set of obstacle coordinates; may be empty but must contain only points inside the grid
     * @param startX    initial x coordinate, 0 ≤ startX < width
     * @param startY    initial y coordinate, 0 ≤ startY < height
     * @param startDirection initial facing direction
     * @throws IllegalArgumentException if any precondition is violated
     */
    public Rover(int width, int height, Set<Point> obstacles,
                 int startX, int startY, Direction startDirection) {
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("Grid dimensions must be positive");
        }
        Objects.requireNonNull(obstacles, "obstacles must not be null");
        for (Point p : obstacles) {
            if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) {
                throw new IllegalArgumentException("Obstacle out of bounds: " + p);
            }
        }
        if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
            throw new IllegalArgumentException("Start position out of bounds");
        }
        Point startPoint = new Point(startX, startY);
        if (obstacles.contains(startPoint)) {
            throw new IllegalArgumentException("Start position is an obstacle");
        }
        this.width = width;
        this.height = height;
        this.obstacles = Set.copyOf(obstacles);
        this.x = startX;
        this.y = startY;
        this.direction = Objects.requireNonNull(startDirection, "direction must not be null");
    }

    /**
     * Executes a script of commands.
     *
     * @param script a non‑null string consisting of characters L, R and M
     * @return the execution result describing success/failure and the rover's state
     * @throws IllegalArgumentException if {@code script} is {@code null}
     */
    public ExecutionResult execute(String script) {
        if (script == null) {
            throw new IllegalArgumentException("script must not be null");
        }
        // remember state before each command to report on failure
        int curX = x;
        int curY = y;
        Direction curDir = direction;
        for (int i = 0; i < script.length(); i++) {
            char cmd = script.charAt(i);
            switch (cmd) {
                case 'L' -> {
                    curDir = switch (curDir) {
                        case NORTH -> Direction.WEST;
                        case WEST -> Direction.SOUTH;
                        case SOUTH -> Direction.EAST;
                        case EAST -> Direction.NORTH;
                    };
                }
                case 'R' -> {
                    curDir = switch (curDir) {
                        case NORTH -> Direction.EAST;
                        case EAST -> Direction.SOUTH;
                        case SOUTH -> Direction.WEST;
                        case WEST -> Direction.NORTH;
                    };
                }
                case 'M' -> {
                    int nextX = curX;
                    int nextY = curY;
                    switch (curDir) {
                        case NORTH -> nextY++;
                        case SOUTH -> nextY--;
                        case EAST -> nextX++;
                        case WEST -> nextX--;
                    }
                    // check bounds
                    if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
                        return new ExecutionResult(false, curX, curY, curDir, "Out of bounds");
                    }
                    // check obstacles (Point does not implement equals, compare manually)
                    boolean isObstacle = false;
                    for (Point p : obstacles) {
                        if (p.x == nextX && p.y == nextY) {
                            isObstacle = true;
                            break;
                        }
                    }
                    if (isObstacle) {
                        return new ExecutionResult(false, curX, curY, curDir, "Obstacle encountered");
                    }
                    // move succeeds
                    curX = nextX;
                    curY = nextY;
                }
                default -> {
                    return new ExecutionResult(false, curX, curY, curDir, "Invalid command");
                }
            }
        }
        // all commands processed successfully – update internal state
        this.x = curX;
        this.y = curY;
        this.direction = curDir;
        return new ExecutionResult(true, curX, curY, curDir, null);
    }
}
