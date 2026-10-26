package de.tum.cit.aet.libraryloans;

/**
 * A book of the library. Books are identified by their ISBN.
 */
public class Book {

    private final String isbn;
    private final String title;

    public Book(String isbn, String title) {
        this.isbn = isbn;
        this.title = title;
    }

    public String getIsbn() {
        return isbn;
    }

    public String getTitle() {
        return title;
    }
}
