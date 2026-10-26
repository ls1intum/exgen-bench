package de.tum.cit.aet.shapeareas;

/**
 * A shape on the canvas of the drawing app.
 */
public interface Shape {

    /**
     * @return the area of this shape
     */
    double area();

    /**
     * @return the perimeter of this shape
     */
    double perimeter();
}
