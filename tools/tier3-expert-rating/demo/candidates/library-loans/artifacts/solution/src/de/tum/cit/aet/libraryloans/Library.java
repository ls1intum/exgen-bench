package de.tum.cit.aet.libraryloans;

import java.util.ArrayList;
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
        if (!books.containsKey(isbn)) {
            throw new IllegalStateException("The library has no book with ISBN " + isbn);
        }
        if (loans.containsKey(isbn)) {
            throw new IllegalStateException("The book with ISBN " + isbn + " is already on loan");
        }
        loans.put(isbn, member);
    }

    /**
     * Ends the loan of the book with the given ISBN.
     *
     * @param isbn the ISBN of the book
     * @throws IllegalStateException if the operation is not allowed
     */
    public void giveBack(String isbn) {
        if (!loans.containsKey(isbn)) {
            throw new IllegalStateException("The book with ISBN " + isbn + " is not on loan");
        }
        loans.remove(isbn);
    }

    /**
     * Returns the titles of the books a member currently has on loan.
     *
     * @param member the name of the member
     * @return the titles of the member's books
     */
    public List<String> loansOf(String member) {
        List<String> titles = new ArrayList<>();
        for (Map.Entry<String, String> loan : loans.entrySet()) {
            if (loan.getValue().equals(member)) {
                titles.add(books.get(loan.getKey()).getTitle());
            }
        }
        return titles;
    }
}
