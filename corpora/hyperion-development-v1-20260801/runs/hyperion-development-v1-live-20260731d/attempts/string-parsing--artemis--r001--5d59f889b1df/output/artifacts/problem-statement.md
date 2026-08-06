## Overview
We work with a tiny key‑value text format. Each line may contain a key and a value separated by the first `=` character. Whitespace around the key and the value is ignored. After trimming, the key must contain at least one character – otherwise the line is discarded. Lines without an `=` are also discarded. The parser must keep the entries in the order they appear, allow duplicate keys, and produce a summary view.

### Text format rules
1. The input is a single `String` that may contain zero or more lines separated by the newline character `"\n"`.
2. A *valid line* contains the character `=`. The first `=` splits the line into **key** and **value**.
3. Leading and trailing whitespace of both parts is removed. The trimmed key must be non‑empty; the trimmed value may be empty.
4. If a line does not contain `=` or the trimmed key is empty, the line is ignored.
5. `null` is treated as an empty string.

### Required behaviour
* For every valid line an `Entry` object is created that stores the trimmed key and value.
* All entries are collected in the order they appear.
* A `Summary` object must expose:
  * `int getEntryCount()` – number of valid entries.
  * `List<String> getKeys()` – the keys of the entries, preserving order and duplicates.
  * `String getFormatted()` – a multi‑line string:
    * first line: `"Count: N"` where `N` is the entry count.
    * subsequent lines: `"key -> value"` for each entry.
    * no trailing newline after the last line.
* An empty input (or input that yields no valid lines) results in a summary with count `0`, an empty key list and the formatted string exactly `"Count: 0"`.

### Worked examples
```text
Input: "  name = Alice \n age=30\ncity = Berlin "
Output formatted string:
Count: 3
name -> Alice
age -> 30
city -> Berlin
```
```text
Input: "invalid line\nkeyOnly=   \n=missingKey\nvalid=ok"
Output formatted string:
Count: 2
keyOnly -> 
valid -> ok
```

## Public API
| Type | Member signature |
|------|------------------|
| `Entry` | `public Entry(String key, String value)`<br>`public String getKey()`<br>`public String getValue()` |
| `Summary` (interface) | `int getEntryCount()`<br>`java.util.List<String> getKeys()`<br>`String getFormatted()` |
| `SummaryImpl` (student‑created) | `public SummaryImpl(Entry[] entries)`<br>`public int getEntryCount()`<br>`public java.util.List<String> getKeys()`<br>`public String getFormatted()` |
| `StructuredTextParser` (student‑created) | `public static Summary parse(String text)` |

## Diagram
```plantuml
@startuml
class <color:testsColor(<testid>105</testid>)>+StructuredTextParser</color> {
    +parse(String): Summary
}
class <color:testsColor(<testid>106</testid>)>+SummaryImpl</color> {
    +SummaryImpl(Entry[])
    +getEntryCount(): int
    +getKeys(): List<String>
    +getFormatted(): String
}
interface Summary {
    +getEntryCount(): int
    +getKeys(): List<String>
    +getFormatted(): String
}
class Entry {
    +Entry(String, String)
    +getKey(): String
    +getValue(): String
}
StructuredTextParser --> SummaryImpl : creates
SummaryImpl ..|> Summary
SummaryImpl --> Entry : uses
hide empty fields
hide empty methods
@enduml
```

## Tasks
[task][Implement SummaryImpl](<testid>110</testid>,<testid>112</testid>,<testid>103</testid>,<testid>108</testid>,<testid>106</testid>,<testid>109</testid>,<testid>113</testid>)
Implement the concrete `SummaryImpl` class. Provide the constructor that receives an array of `Entry` objects and store them immutably. Implement all methods of the `Summary` interface so that they return the correct entry count, the ordered list of keys, and the formatted string described above.

[task][Implement StructuredTextParser](<testid>104</testid>,<testid>117</testid>,<testid>114</testid>,<testid>101</testid>,<testid>115</testid>,<testid>102</testid>,<testid>116</testid>,<testid>107</testid>,<testid>105</testid>,<testid>100</testid>,<testid>111</testid>)
Implement the static `parse` method. It must handle a `null` argument as an empty string, split the input into lines, apply the parsing rules, create `Entry` objects for every valid line and return a `SummaryImpl` containing those entries.