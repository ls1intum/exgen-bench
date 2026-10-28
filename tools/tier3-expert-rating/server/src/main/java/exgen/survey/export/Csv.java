package exgen.survey.export;

import java.util.List;
import java.util.Map;

/**
 * CSV as the study's tables have always been written: a header row, {@code \n} line ends, and a
 * cell quoted only when it holds a quote, a comma or a line end. A cell that starts like a
 * spreadsheet formula is prefixed with {@code '}, so opening the file never runs a rater's text.
 */
public final class Csv {
    private Csv() {}

    public static String write(List<String> columns, List<Map<String, Object>> rows) {
        var csv = new StringBuilder();
        csv.append(String.join(",", columns.stream().map(Csv::cell).toList())).append('\n');
        for (var row : rows) {
            csv.append(String.join(
                            ",",
                            columns.stream()
                                    .map(column -> cell(row.get(column)))
                                    .toList()))
                    .append('\n');
        }
        return csv.toString();
    }

    private static String cell(Object value) {
        if (value == null) {
            return "";
        }
        var text = value.toString();
        if (text.isEmpty()) {
            return "";
        }
        if ("=+-@\t\r\uFF1D\uFF0B\uFF0D\uFF20".indexOf(text.charAt(0)) >= 0) {
            text = "'" + text;
        }
        if (text.contains("\"") || text.contains(",") || text.contains("\n")) {
            return "\"" + text.replace("\"", "\"\"") + "\"";
        }
        return text;
    }
}
