package de.tum.cit.aet.exgeninheritanceandpolymorphism;

/**
 * Circle shape defined by its radius.
 */
public class Circle extends Shape {
    private final double radius;

    /**
     * Creates a circle.
     *
     * @param radius the radius, must be non‑negative
     */
    public Circle(double radius) {
        this.radius = radius;
    }

    /** Returns the radius. */
    public double getRadius() {
        return radius;
    }

    @Override
    public double getExtent() {
        return Math.PI * radius * radius;
    }
}
