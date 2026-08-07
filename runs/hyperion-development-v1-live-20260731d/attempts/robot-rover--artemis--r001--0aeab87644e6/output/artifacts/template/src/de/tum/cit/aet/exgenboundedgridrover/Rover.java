package de.tum.cit.aet.exgenboundedgridrover;

import java.util.Objects;
import java.util.Set;

/**
 * Core class whose {@link #execute(String)} method must be implemented by the student.
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
     */
    public Rover(int width, int height, Set<Point> obstacles,
                 int startX, int startY, Direction startDirection) {
        // Basic validation – students may rely on these checks being present.
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
     * @return the execution result
     */
    public ExecutionResult execute(String script) {
        // TODO S1: implement the state‑transition logic according to the specification.
        throw new UnsupportedOperationException("Not implemented");
    }
}
