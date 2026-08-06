package de.tum.cit.aet.exgenboundedgridrover;

/**
 * Immutable result of a {@link Rover#execute(String)} call.
 */
public final class ExecutionResult {
    private final boolean success;
    private final int x;
    private final int y;
    private final Direction direction;
    private final String errorMessage;

    public ExecutionResult(boolean success, int x, int y, Direction direction, String errorMessage) {
        this.success = success;
        this.x = x;
        this.y = y;
        this.direction = direction;
        this.errorMessage = errorMessage;
    }

    public boolean isSuccess() {
        return success;
    }

    public int getX() {
        return x;
    }

    public int getY() {
        return y;
    }

    public Direction getDirection() {
        return direction;
    }

    public String getErrorMessage() {
        return errorMessage;
    }
}
