package de.tum.cit.aet.libraryloans;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The books of a library and the members who currently have them on loan.
 */
public class Library {

    /** All books of the library, by ISBN. */
    private final Map<String, Book> books = new HashMap<>();

    /** The member who has each lent book, by ISBN. Books that are not lent have no entry. */
    private final Map<String, String> loans = new LinkedHashMap<>();

    /**
     * Adds a book to the library.
     *
     * @param book the book to add
     */
    public void addBook(Book book) {
        books.put(book.getIsbn(), book);
    }

    /**
     * Lends the book with the given ISBN to a member.
     *
     * @param isbn   the ISBN of the book
     * @param member the name of the member
     * @throws IllegalStateException if the operation is not allowed
     */
    public void lend(String isbn, String member) {
        // TODO: check that the book exists and is not lent, then record the loan.
    }

    /**
     * Ends the loan of the book with the given ISBN.
     *
     * @param isbn the ISBN of the book
     * @throws IllegalStateException if the operation is not allowed
     */
    public void giveBack(String isbn) {
        // TODO: check that the book is lent, then remove the loan.
    }

    /**
     * Returns the titles of the books a member currently has on loan.
     *
     * @param member the name of the member
     * @return the titles of the member's books
     */
    public List<String> loansOf(String member) {
        // TODO: collect the titles of the member's books.
        return null;
    }
}
