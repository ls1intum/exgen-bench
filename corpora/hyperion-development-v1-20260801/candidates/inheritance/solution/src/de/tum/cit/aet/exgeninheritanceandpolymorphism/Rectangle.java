package de.tum.cit.aet.exgeninheritanceandpolymorphism;

/**
 * Rectangle shape defined by its width and height.
 */
public class Rectangle extends Shape {
    private final double width;
    private final double height;

    /**
     * Creates a rectangle.
     *
     * @param width  the width, must be non‑negative
     * @param height the height, must be non‑negative
     */
    public Rectangle(double width, double height) {
        this.width = width;
        this.height = height;
    }

    /** Returns the width. */
    public double getWidth() {
        return width;
    }

    /** Returns the height. */
    public double getHeight() {
        return height;
    }

    @Override
    public double getExtent() {
        return width * height;
    }
}
