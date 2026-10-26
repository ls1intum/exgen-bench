# Library Loans

The town library wants to replace its paper loan cards with a small Java program. Every book has an
ISBN and a title, and members are identified by their name. The class `Book` is already given. You
complete the class `Library`, which knows all books of the library and remembers which member
currently has which book.

A library must never get into an impossible state. Whenever an operation is not allowed, your method
must throw an `IllegalStateException` and leave the library unchanged.

### Tasks

1. [task][Lend a book](testLendRecordsLoan,testLendUnknownBookThrows,testLendAlreadyLentBookThrows)
   Implement `lend(String isbn, String member)`. It records that the book with the given ISBN is now
   on loan to the member. Lending a book the library does not own, or a book that is already on loan,
   is not allowed.

2. [task][Return a book](testGiveBackEndsLoan,testGiveBackBookNotLentThrows)
   Implement `giveBack(String isbn)`. It ends the loan of the book with the given ISBN, so the book
   can be lent again. Returning a book that is not on loan is not allowed.

3. [task][Loans of a member](testLoansOfListsTitlesInLendingOrder,testLoansOfMemberWithoutLoans)
   Implement `loansOf(String member)`. It returns a list with the titles of all books the member
   currently has on loan. A member without loans gets an empty list, never `null`.
