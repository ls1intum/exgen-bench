package de.tum.cit.aet.exgeninheritanceandpolymorphism;

/**
 * Triangle shape defined by its base and height.
 */
public class Triangle extends Shape {
    private final double base;
    private final double height;

    /**
     * Creates a triangle.
     *
     * @param base   the base length, must be non‑negative
     * @param height the height, must be non‑negative
     */
    public Triangle(double base, double height) {
        this.base = base;
        this.height = height;
    }

    /** Returns the base. */
    public double getBase() {
        return base;
    }

    /** Returns the height. */
    public double getHeight() {
        return height;
    }

    @Override
    public double getExtent() {
        return 0.5 * base * height;
    }
}
