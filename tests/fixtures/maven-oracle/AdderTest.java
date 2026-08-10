import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** The smallest exercise shape the oracle has to decide: the solution adds, the template does not. */
class AdderTest {

    @Test
    void addsTwoPositiveNumbers() {
        assertEquals(5, Adder.add(2, 3));
    }

    @Test
    void addsNegativeNumbers() {
        assertEquals(-5, Adder.add(-2, -3));
    }
}
