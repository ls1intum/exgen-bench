package de.tum.cit.aet.shapeareas;

/**
 * A circle with a given radius.
 */
public class Circle implements Shape {

    private final double radius;

    public Circle(double radius) {
        this.radius = radius;
    }

    public double getRadius() {
        return radius;
    }

    @Override
    public double area() {
        // TODO: compute the area of the circle.
        return -1;
    }

    @Override
    public double perimeter() {
        // TODO: compute the perimeter of the circle.
        return -1;
    }
}
