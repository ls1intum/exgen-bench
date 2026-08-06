package de.tum.cit.aet.exgeninheritanceandpolymorphism;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

import static de.tum.in.test.api.util.ReflectionTestUtils.*;

import de.tum.in.test.api.BlacklistPath;
import de.tum.in.test.api.StrictTimeout;
import de.tum.in.test.api.WhitelistPath;
import de.tum.in.test.api.jupiter.Public;

/**
 * Behavioral tests for the geometric shape hierarchy.
 */
@Public
@WhitelistPath("target")
@BlacklistPath("target/test-classes")
class ShapeBehaviorTest {

    @Test
    @StrictTimeout(1)
    void rectangleArea() throws ReflectiveOperationException {
        double width = 3.0;
        double height = 4.0;
        Object rect = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Rectangle"), double.class, double.class), width, height);
        // verify getters
        double w = (double) invokeMethod(rect, getMethod(rect, "getWidth"));
        double h = (double) invokeMethod(rect, getMethod(rect, "getHeight"));
        assertEquals(width, w, "Rectangle width getter returned wrong value");
        assertEquals(height, h, "Rectangle height getter returned wrong value");
        double area = (double) invokeMethod(rect, getMethod(rect, "getExtent"));
        assertEquals(width * height, area, "Rectangle area calculation is incorrect");
    }

    @Test
    @StrictTimeout(1)
    void triangleArea() throws ReflectiveOperationException {
        double base = 5.0;
        double height = 2.0;
        Object tri = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Triangle"), double.class, double.class), base, height);
        double b = (double) invokeMethod(tri, getMethod(tri, "getBase"));
        double h = (double) invokeMethod(tri, getMethod(tri, "getHeight"));
        assertEquals(base, b, "Triangle base getter returned wrong value");
        assertEquals(height, h, "Triangle height getter returned wrong value");
        double area = (double) invokeMethod(tri, getMethod(tri, "getExtent"));
        assertEquals(0.5 * base * height, area, "Triangle area calculation is incorrect");
    }

    @Test
    @StrictTimeout(1)
    void circleArea() throws ReflectiveOperationException {
        double radius = 2.0;
        Object circ = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Circle"), double.class), radius);
        double r = (double) invokeMethod(circ, getMethod(circ, "getRadius"));
        assertEquals(radius, r, "Circle radius getter returned wrong value");
        double area = (double) invokeMethod(circ, getMethod(circ, "getExtent"));
        assertEquals(Math.PI * radius * radius, area, "Circle area calculation is incorrect");
    }

    @Test
    @StrictTimeout(1)
    void polymorphicSum() throws ReflectiveOperationException {
        Object rect = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Rectangle"), double.class, double.class), 2.0, 3.0);
        Object tri = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Triangle"), double.class, double.class), 4.0, 5.0);
        Object circ = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Circle"), double.class), 1.0);
        Shape[] shapes = new Shape[] { (Shape) rect, (Shape) tri, (Shape) circ };
        double sum = 0.0;
        for (Shape s : shapes) {
            sum += s.getExtent();
        }
        double expected = 2.0 * 3.0 + 0.5 * 4.0 * 5.0 + Math.PI * 1.0 * 1.0;
        assertEquals(expected, sum, "Polymorphic sum of extents is incorrect");
    }

    // Additional partition tests
    @Test
    @StrictTimeout(1)
    void rectangleZeroWidth() throws ReflectiveOperationException {
        double width = 0.0;
        double height = 5.0;
        Object rect = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Rectangle"), double.class, double.class), width, height);
        double area = (double) invokeMethod(rect, getMethod(rect, "getExtent"));
        assertEquals(0.0, area, "Rectangle area with zero width should be 0");
    }

    @Test
    @StrictTimeout(1)
    void rectangleZeroHeight() throws ReflectiveOperationException {
        double width = 5.0;
        double height = 0.0;
        Object rect = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Rectangle"), double.class, double.class), width, height);
        double area = (double) invokeMethod(rect, getMethod(rect, "getExtent"));
        assertEquals(0.0, area, "Rectangle area with zero height should be 0");
    }

    @Test
    @StrictTimeout(1)
    void rectangleLarge() throws ReflectiveOperationException {
        double width = 1e6;
        double height = 2e6;
        Object rect = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Rectangle"), double.class, double.class), width, height);
        double area = (double) invokeMethod(rect, getMethod(rect, "getExtent"));
        assertEquals(width * height, area, "Rectangle large values area incorrect");
    }

    @Test
    @StrictTimeout(1)
    void triangleZeroBase() throws ReflectiveOperationException {
        double base = 0.0;
        double height = 4.0;
        Object tri = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Triangle"), double.class, double.class), base, height);
        double area = (double) invokeMethod(tri, getMethod(tri, "getExtent"));
        assertEquals(0.0, area, "Triangle area with zero base should be 0");
    }

    @Test
    @StrictTimeout(1)
    void triangleZeroHeight() throws ReflectiveOperationException {
        double base = 4.0;
        double height = 0.0;
        Object tri = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Triangle"), double.class, double.class), base, height);
        double area = (double) invokeMethod(tri, getMethod(tri, "getExtent"));
        assertEquals(0.0, area, "Triangle area with zero height should be 0");
    }

    @Test
    @StrictTimeout(1)
    void triangleLarge() throws ReflectiveOperationException {
        double base = 1e5;
        double height = 2e5;
        Object tri = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Triangle"), double.class, double.class), base, height);
        double area = (double) invokeMethod(tri, getMethod(tri, "getExtent"));
        assertEquals(0.5 * base * height, area, "Triangle large values area incorrect");
    }

    @Test
    @StrictTimeout(1)
    void circleZeroRadius() throws ReflectiveOperationException {
        double radius = 0.0;
        Object circ = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Circle"), double.class), radius);
        double area = (double) invokeMethod(circ, getMethod(circ, "getExtent"));
        assertEquals(0.0, area, "Circle area with zero radius should be 0");
    }

    @Test
    @StrictTimeout(1)
    void circleLarge() throws ReflectiveOperationException {
        double radius = 1e5;
        Object circ = newInstance(getConstructor(getClazz("de.tum.cit.aet.exgeninheritanceandpolymorphism.Circle"), double.class), radius);
        double area = (double) invokeMethod(circ, getMethod(circ, "getExtent"));
        assertEquals(Math.PI * radius * radius, area, "Circle large radius area incorrect");
    }

}
