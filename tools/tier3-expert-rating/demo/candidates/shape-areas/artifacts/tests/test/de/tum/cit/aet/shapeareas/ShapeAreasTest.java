package de.tum.cit.aet.shapeareas;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ShapeAreasTest {

    private static final double DELTA = 1e-9;

    @Test
    void testCircleArea() {
        assertEquals(4 * Math.PI, new Circle(2.0).area(), DELTA,
                "A circle with radius 2.0 should have an area of 4 * PI (about 12.566).");
    }

    @Test
    void testCirclePerimeter() {
        assertEquals(4 * Math.PI, new Circle(2.0).perimeter(), DELTA,
                "A circle with radius 2.0 should have a perimeter of 4 * PI (about 12.566).");
    }

    @Test
    void testRectanglePerimeter() {
        assertEquals(14.0, new Rectangle(3.0, 4.0).perimeter(), DELTA,
                "A 3.0 x 4.0 rectangle should have a perimeter of 14.0.");
    }

    @Test
    void testSquareArea() {
        assertEquals(25.0, new Square(5.0).area(), DELTA,
                "A square with side 5.0 should have an area of 25.0. Does Square pass its side on to Rectangle?");
    }

    @Test
    void testSquarePerimeter() {
        assertEquals(20.0, new Square(5.0).perimeter(), DELTA,
                "A square with side 5.0 should have a perimeter of 20.0.");
    }

    @Test
    void testTotalAreaOfMixedShapes() {
        ShapeCollection collection = new ShapeCollection();
        collection.add(new Circle(1.0));
        collection.add(new Rectangle(2.0, 3.0));
        collection.add(new Square(2.0));
        assertEquals(Math.PI + 6.0 + 4.0, collection.totalArea(), DELTA,
                "A circle with radius 1.0, a 2.0 x 3.0 rectangle and a square with side 2.0 should have a total area of PI + 10.0.");
    }

    @Test
    void testTotalAreaOfEmptyCollection() {
        assertEquals(0.0, new ShapeCollection().totalArea(), DELTA,
                "An empty collection should have a total area of 0.0.");
    }

    @Test
    void testTotalAreaOfSquares() {
        ShapeCollection collection = new ShapeCollection();
        collection.add(new Square(1.0));
        collection.add(new Square(3.0));
        assertEquals(10.0, collection.totalArea(), DELTA,
                "Squares with sides 1.0 and 3.0 should have a total area of 10.0.");
    }
}
