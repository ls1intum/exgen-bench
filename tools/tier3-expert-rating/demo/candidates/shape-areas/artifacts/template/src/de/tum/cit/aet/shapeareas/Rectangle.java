package de.tum.cit.aet.shapeareas;

/**
 * A rectangle with a given width and height.
 */
public class Rectangle implements Shape {

    private final double width;
    private final double height;

    public Rectangle(double width, double height) {
        this.width = width;
        this.height = height;
    }

    public double getWidth() {
        return width;
    }

    public double getHeight() {
        return height;
    }

    @Override
    public double area() {
        return width * height;
    }

    @Override
    public double perimeter() {
        // TODO: compute the perimeter of the rectangle.
        return -1;
    }
}
