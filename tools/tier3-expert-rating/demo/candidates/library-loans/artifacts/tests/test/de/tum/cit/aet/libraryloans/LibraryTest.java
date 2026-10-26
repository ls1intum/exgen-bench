package de.tum.cit.aet.libraryloans;

import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class LibraryTest {

    private Library library;

    @BeforeEach
    void setUp() {
        library = new Library();
        library.addBook(new Book("978-0-01", "The Quiet Harbour"));
        library.addBook(new Book("978-0-02", "Seven Small Bridges"));
        library.addBook(new Book("978-0-03", "A Year of Rain"));
    }

    @Test
    void testLendRecordsLoan() {
        library.lend("978-0-01", "Ana");
        assertEquals(List.of("The Quiet Harbour"), library.loansOf("Ana"),
                "After lend(\"978-0-01\", \"Ana\"), loansOf(\"Ana\") should contain the title \"The Quiet Harbour\".");
    }

    @Test
    void testLendUnknownBookThrows() {
        assertThrows(IllegalStateException.class, () -> library.lend("978-9-99", "Ana"),
                "Lending a book the library does not own should throw an IllegalStateException.");
    }

    @Test
    void testLendAlreadyLentBookThrows() {
        library.lend("978-0-02", "Ana");
        assertThrows(IllegalStateException.class, () -> library.lend("978-0-02", "Ben"),
                "Lending a book that is already on loan should throw an IllegalStateException.");
    }

    @Test
    void testGiveBackEndsLoan() {
        library.lend("978-0-01", "Ana");
        library.giveBack("978-0-01");
        assertEquals(List.of(), library.loansOf("Ana"),
                "After the only book of \"Ana\" was given back, loansOf(\"Ana\") should return an empty list.");
    }

    @Test
    void testGiveBackBookNotLentThrows() {
        assertThrows(IllegalStateException.class, () -> library.giveBack("978-0-03"),
                "Giving back a book that is not on loan should throw an IllegalStateException.");
    }

    @Test
    void testLoansOfListsTitlesInLendingOrder() {
        library.lend("978-0-03", "Ana");
        library.lend("978-0-02", "Ben");
        library.lend("978-0-01", "Ana");
        assertEquals(List.of("A Year of Rain", "The Quiet Harbour"), library.loansOf("Ana"),
                "loansOf(\"Ana\") should list the titles of exactly the books lent to \"Ana\", in the order they were lent.");
    }

    @Test
    void testLoansOfMemberWithoutLoans() {
        assertEquals(List.of(), library.loansOf("Chris"),
                "A member without loans should get an empty list, not null.");
    }
}
