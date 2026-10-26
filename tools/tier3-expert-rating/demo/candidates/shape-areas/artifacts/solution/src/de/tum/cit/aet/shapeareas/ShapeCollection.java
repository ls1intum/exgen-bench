package de.tum.cit.aet.shapeareas;

import java.util.ArrayList;
import java.util.List;

/**
 * All shapes on the canvas.
 */
public class ShapeCollection {

    private final List<Shape> shapes = new ArrayList<>();

    /**
     * Adds a shape to the collection.
     *
     * @param shape the shape to add
     */
    public void add(Shape shape) {
        shapes.add(shape);
    }

    /**
     * @return the sum of the areas of all shapes in the collection
     */
    public double totalArea() {
        double total = 0.0;
        for (Shape shape : shapes) {
            total += shape.area();
        }
        return total;
    }
}
