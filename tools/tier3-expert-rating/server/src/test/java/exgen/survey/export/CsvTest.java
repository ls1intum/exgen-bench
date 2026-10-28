package exgen.survey.export;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CsvTest {
    static Map<String, Object> row(Object a, Object b, Object c) {
        var row = new HashMap<String, Object>();
        row.put("a", a);
        row.put("b", b);
        row.put("c", c);
        return row;
    }

    /** The output of {@code src/export/serialize.ts} for the same rows, which exports were written with. */
    @Test
    void quotesAndDefusesCellsAsTheEarlierExportsDid() {
        var rows = List.of(
                row("=SUM(A1)", "x,y", "say \"hi\""),
                row("-5", "line\nbreak", true),
                row("\tTab", "ok\r", null),
                row("＝full", "", 3),
                row("+1", "@me", false));
        assertThat(Csv.write(List.of("a", "b", "c"), rows))
                .isEqualTo("a,b,c\n'=SUM(A1),\"x,y\",\"say \"\"hi\"\"\"\n'-5,\"line\nbreak\",true\n'\tTab,ok\r,\n"
                        + "'＝full,,3\n'+1,'@me,false\n");
        assertThat(Csv.write(List.of("a"), List.of(new LinkedHashMap<>()))).isEqualTo("a\n\n");
    }
}
