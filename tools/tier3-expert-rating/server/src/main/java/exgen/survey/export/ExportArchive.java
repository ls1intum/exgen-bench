package exgen.survey.export;

import exgen.survey.rating.Step;
import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.SurveyStore.RaterRow;
import exgen.survey.rating.SurveyStore.StepRow;
import exgen.survey.rating.Times;
import exgen.survey.study.Answer;
import exgen.survey.study.Instrument.ChoiceItem;
import exgen.survey.study.Instrument.Item;
import exgen.survey.study.Instrument.MultiItem;
import exgen.survey.study.Instrument.Option;
import exgen.survey.study.Instrument.PartId;
import exgen.survey.study.Instrument.TextItem;
import exgen.survey.study.LoadedStudy;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * The study's results as tidy tables: one row per rating and one column per item, plus one table
 * per questionnaire and a codebook generated from the instrument, so every column is documented by
 * the same text the raters read. Raters appear only under their pseudonymous IDs.
 */
public final class ExportArchive {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final TypeReference<LinkedHashMap<String, Answer>> ANSWERS = new TypeReference<>() {};

    private ExportArchive() {}

    record Column(String name, String description, Function<Map<String, Answer>, Object> value) {}

    record Header(String name, String description) {}

    record Table(String file, String description, List<Header> columns, List<Map<String, Object>> rows) {}

    static List<Column> columnsFor(List<Item> items) {
        var columns = new ArrayList<Column>();
        for (var item : items) {
            var id = item.id();
            switch (item) {
                case TextItem text ->
                    columns.add(new Column(id, text.prompt(), answers -> field(answers, id, Answer::text)));
                case MultiItem multi -> {
                    columns.add(new Column(
                            id,
                            multi.prompt() + " Values, separated by \";\": " + describe(multi.options()) + ".",
                            answers -> field(
                                    answers,
                                    id,
                                    answer -> answer.values() == null ? null : String.join(";", answer.values()))));
                    columns.addAll(followUps(id, multi.options()));
                }
                case ChoiceItem choice -> {
                    columns.add(new Column(
                            id,
                            choice.prompt() + " Values: " + describe(choice.options()) + ".",
                            answers -> field(answers, id, Answer::value)));
                    columns.addAll(followUps(id, choice.options()));
                }
            }
        }
        return columns;
    }

    private static Object field(Map<String, Answer> answers, String id, Function<Answer, Object> value) {
        var answer = answers.get(id);
        return answer == null ? null : value.apply(answer);
    }

    private static String describe(List<Option> options) {
        return options.stream()
                .map(option -> option.value() + " = " + option.label())
                .collect(Collectors.joining("; "));
    }

    private static List<Column> followUps(String id, List<Option> options) {
        var details =
                options.stream().map(Option::detail).filter(Objects::nonNull).toList();
        var choices = details.stream()
                .filter(detail -> detail.choices() != null)
                .flatMap(detail -> detail.choices().stream())
                .toList();
        var columns = new ArrayList<Column>();
        if (!choices.isEmpty()) {
            columns.add(new Column(
                    id + "_choice",
                    "Follow-up of " + id + ": "
                            + choices.stream()
                                    .map(choice -> choice.value() + " = " + choice.label())
                                    .collect(Collectors.joining("; "))
                            + ".",
                    answers -> field(answers, id, Answer::choice)));
        }
        if (!details.isEmpty()) {
            var labels = new LinkedHashSet<String>();
            details.forEach(detail -> labels.add(detail.label()));
            columns.add(new Column(
                    id + "_text",
                    "Free text of " + id + ": " + String.join(" / ", labels) + ".",
                    answers -> field(answers, id, Answer::text)));
        }
        return columns;
    }

    private static Map<String, Answer> parse(StepRow row) {
        return row == null || row.answers() == null ? Map.of() : JSON.readValue(row.answers(), ANSWERS);
    }

    private static Long seconds(StepRow row) {
        if (row == null || row.openedAt() == null || row.submittedAt() == null) {
            return null;
        }
        return Math.round(Duration.between(row.openedAt(), row.submittedAt()).toMillis() / 1000.0);
    }

    /** A row of a table: the values in column order, without the missing ones. */
    private static final class Row extends LinkedHashMap<String, Object> {
        Row with(String column, Object value) {
            if (value != null) {
                put(column, value);
            }
            return this;
        }
    }

    static List<Table> tables(LoadedStudy loaded, SurveyStore store, List<String> roles) {
        var study = loaded.study();
        var instrument = loaded.instrument();
        var raters = store.raters().stream()
                .filter(rater -> roles.contains(rater.role().id()))
                .toList();
        var steps = store.steps();
        Function<String, Function<String, StepRow>> stepOf = raterId -> key -> steps.stream()
                .filter(row -> row.raterId().equals(raterId) && row.step().equals(key))
                .findFirst()
                .orElse(null);
        var raterColumns = List.of(
                new Header("rater_id", "Pseudonymous rater ID."), new Header("role", "main, reserve, pilot, or test."));

        record PartColumn(PartId part, Column column) {}
        var questionnaire = new ArrayList<PartColumn>();
        for (var part : instrument.questionnaire().parts()) {
            columnsFor(part.items()).forEach(column -> questionnaire.add(new PartColumn(part.id(), column)));
        }
        var ratingColumns = new ArrayList<>(raterColumns);
        ratingColumns.addAll(
                List.of(
                        new Header("exercise_code", "The study team's code of the exercise (brief and phase)."),
                        new Header("exercise_id", "The random ID raters saw."),
                        new Header(
                                "exercise_sha256",
                                "SHA-256 of the built exercise file the rater was shown, from manifest.json."),
                        new Header("phase", "Course phase of the brief: early, middle, or late."),
                        new Header("position", "Position of the exercise in the rater's session, from 1."),
                        new Header(
                                "assignment",
                                "planned (study.yaml), additional, backup (stands in for another rater), or tie_breaker."),
                        new Header("replaces", "For a backup assignment, the rater it replaces."),
                        new Header("instrument_version", "Version of the instrument the answers were given with."),
                        new Header("complete", "Whether all four parts were submitted."),
                        new Header(
                                "findings_presentations",
                                "Client-reported presentation IDs on requests for opened Part D material, not proof of attention; distinct values separated by ';'. legacy-unversioned means no exact historical presentation is known; categories-v1 is the category overview. Blank means no Part D exposure was recorded."),
                        new Header(
                                "findings_presentation_at_submit",
                                "Browser presentation reported when Part D was submitted. Missing headers and submissions predating tracking are legacy-unversioned; this does not reconstruct an exact past version. Blank means Part D was not submitted."),
                        new Header(
                                "findings_presentation_mixed",
                                "Whether more than one distinct presentation ID was recorded for Part D. This flags possibly mixed exposure, not proof of different rendered layouts. A single observed ID does not prove there were no unrecorded exposures; legacy-unversioned may encompass earlier revisions. Blank means no exposure was recorded.")));
        for (var part : PartId.values()) {
            ratingColumns.add(new Header(
                    "seconds_" + part,
                    "Seconds between opening Part " + part + "'s material and submitting its answers."));
        }
        for (var column : questionnaire) {
            ratingColumns.add(new Header(
                    column.column().name(),
                    "Part " + column.part() + ". " + column.column().description()));
        }
        var ratings = new ArrayList<Map<String, Object>>();
        for (var rater : raters) {
            var of = stepOf.apply(rater.id());
            // The order in the rater's session, from 1; positions skip assignments that were removed.
            var order = 0;
            for (var assignment : store.assignments(rater.id())) {
                var parts = new LinkedHashMap<PartId, StepRow>();
                for (var part : PartId.values()) {
                    parts.put(
                            part,
                            of.apply(Step.part(assignment.position(), part).key()));
                }
                order++;
                if (parts.get(PartId.A) == null || parts.get(PartId.A).submittedAt() == null) {
                    continue;
                }
                var entry = loaded.manifest().entry(assignment.exercise());
                var planned = study.exercise(assignment.exercise());
                var row = new Row()
                        .with("rater_id", rater.id())
                        .with("role", rater.role().id())
                        .with("exercise_code", assignment.exercise())
                        .with("exercise_id", loaded.idOf().get(assignment.exercise()))
                        .with("exercise_sha256", entry == null ? null : entry.sha256())
                        .with("phase", planned == null ? null : planned.phase())
                        .with("position", order)
                        .with("assignment", assignment.kind())
                        .with("replaces", assignment.replaces())
                        .with("instrument_version", parts.get(PartId.A).instrumentVersion())
                        .with(
                                "complete",
                                parts.values().stream().allMatch(step -> step != null && step.submittedAt() != null));
                var findingsStep = parts.get(PartId.D);
                var presentations = findingsStep == null ? List.<String>of() : findingsStep.findingsPresentations();
                row.with("findings_presentations", presentations.isEmpty() ? null : String.join(";", presentations));
                row.with(
                        "findings_presentation_at_submit",
                        findingsStep == null ? null : findingsStep.findingsPresentationAtSubmit());
                row.with("findings_presentation_mixed", presentations.isEmpty() ? null : presentations.size() > 1);
                parts.forEach((part, step) -> row.with("seconds_" + part, seconds(step)));
                var answers = new LinkedHashMap<PartId, Map<String, Answer>>();
                parts.forEach((part, step) -> answers.put(part, parse(step)));
                for (var column : questionnaire) {
                    row.with(column.column().name(), column.column().value().apply(answers.get(column.part())));
                }
                ratings.add(row);
            }
        }

        var tables = new ArrayList<Table>();
        var raterTableColumns = new ArrayList<>(raterColumns);
        raterTableColumns.addAll(List.of(
                new Header("consented_at", "When the rater gave consent (UTC)."),
                new Header("declined_at", "When the rater declined to take part (UTC)."),
                new Header(
                        "withdrawn_at", "When the rater withdrew; their answers were deleted at their request (UTC)."),
                new Header("deadline", "The date the rater was asked to finish by."),
                new Header(
                        "added_at",
                        "When the study team added the rater during the study; empty for a rater of the plan (UTC).")));
        tables.add(new Table(
                "raters.csv",
                "One row per rater: consent and deadline.",
                raterTableColumns,
                raters.stream()
                        .map(rater -> (Map<String, Object>) new Row()
                                .with("rater_id", rater.id())
                                .with("role", rater.role().id())
                                .with(
                                        "consented_at",
                                        submittedAt(stepOf.apply(rater.id()).apply("consent")))
                                .with("declined_at", Times.iso(rater.declinedAt()))
                                .with("withdrawn_at", Times.iso(rater.withdrawnAt()))
                                .with(
                                        "deadline",
                                        rater.deadline() == null
                                                ? null
                                                : rater.deadline().toString())
                                .with("added_at", Times.iso(rater.addedAt())))
                        .toList()));
        tables.add(new Table(
                "ratings.csv",
                "One row per rating of an exercise, with one column per questionnaire item.",
                ratingColumns,
                ratings));
        tables.add(section(
                raters,
                stepOf,
                raterColumns,
                "background.csv",
                "One row per rater: the background questionnaire.",
                "background",
                instrument.background().items()));
        tables.add(section(
                raters,
                stepOf,
                raterColumns,
                "exit.csv",
                "One row per rater: looking back on the exercises.",
                "exit",
                instrument.exit().items()));
        tables.add(section(
                raters,
                stepOf,
                raterColumns,
                "briefs.csv",
                "One row per rater: feedback on the briefs.",
                "briefs",
                instrument.briefs().items()));
        var roleOf = raters.stream()
                .collect(Collectors.toMap(RaterRow::id, rater -> rater.role().id()));
        tables.add(new Table(
                "events.csv",
                "Which material views and files raters opened, in order, and when the guided tour of the exercise"
                        + " screen ran. The tour's time counts toward the part it ran in, usually Part A of the first"
                        + " exercise; subtract the time from `tour` to `tour-end` to time the part alone. A `tour`"
                        + " without a following `tour-end` means the rater left the page during the tour.",
                List.of(
                        raterColumns.get(0),
                        raterColumns.get(1),
                        new Header("step", "The step the event belongs to, such as exercise-1-B."),
                        new Header("type", "view: a material tab or the guided tour; file: a template file."),
                        new Header(
                                "target",
                                "The tab; `tour` when the guided tour starts and `tour-end` when it ends or is skipped; or the file path."),
                        new Header("at", "When the server received the event (UTC).")),
                store.events().stream()
                        .filter(event -> roleOf.containsKey(event.raterId()))
                        .map(event -> (Map<String, Object>) new Row()
                                .with("rater_id", event.raterId())
                                .with("step", event.step())
                                .with("type", event.type())
                                .with("target", event.target())
                                .with("at", Times.iso(event.at()))
                                .with("role", roleOf.get(event.raterId())))
                        .toList()));
        tables.add(new Table(
                "changes.csv",
                "What the study team changed during the study, in order: raters added, exercises assigned or removed, links, deadlines, withdrawals.",
                List.of(
                        new Header("at", "When the change was made (UTC)."),
                        new Header("action", "What was changed."),
                        new Header("rater_id", "The rater it concerns."),
                        new Header("detail", "The change in words.")),
                store.changes().stream()
                        .filter(change -> change.raterId() == null || roleOf.containsKey(change.raterId()))
                        .map(change -> (Map<String, Object>) new Row()
                                .with("at", Times.iso(change.at()))
                                .with("action", change.action())
                                .with("rater_id", change.raterId())
                                .with("detail", change.detail()))
                        .toList()));
        return tables;
    }

    private static String submittedAt(StepRow row) {
        return row == null ? null : Times.iso(row.submittedAt());
    }

    private static Table section(
            List<RaterRow> raters,
            Function<String, Function<String, StepRow>> stepOf,
            List<Header> raterColumns,
            String file,
            String description,
            String key,
            List<Item> items) {
        var columns = columnsFor(items);
        var headers = new ArrayList<>(raterColumns);
        headers.add(new Header("submitted_at", "When the answers were submitted (UTC)."));
        columns.forEach(column -> headers.add(new Header(column.name(), column.description())));
        var rows = new ArrayList<Map<String, Object>>();
        for (var rater : raters) {
            var row = stepOf.apply(rater.id()).apply(key);
            if (row == null || row.submittedAt() == null) {
                continue;
            }
            var answers = parse(row);
            var values = new Row()
                    .with("rater_id", rater.id())
                    .with("role", rater.role().id())
                    .with("submitted_at", Times.iso(row.submittedAt()));
            columns.forEach(column -> values.with(column.name(), column.value().apply(answers)));
            rows.add(values);
        }
        return new Table(file, description, headers, rows);
    }

    static String codebook(LoadedStudy loaded, List<Table> tables, List<String> roles) {
        var sections = tables.stream()
                .map(table -> "## " + table.file() + "\n\n" + table.description()
                        + "\n\n| Column | Meaning |\n| --- | --- |\n"
                        + table.columns().stream()
                                .map(column -> "| `" + column.name() + "` | "
                                        + column.description()
                                                .replace("|", "\\|")
                                                .replace("\n", " ") + " |")
                                .collect(Collectors.joining("\n"))
                        + "\n")
                .collect(Collectors.joining("\n"));
        return "# " + loaded.study().title() + ": data export\n\n"
                + "Study `" + loaded.study().id() + "`, instrument version "
                + loaded.instrument().version()
                + ", roles " + String.join(", ", roles) + ".\n"
                + """
                Raters appear only under pseudonymous IDs. Before publishing, remove identifying details from free
                text and coarsen the background answers. `data.json` holds the same answers with the instrument.
                In the CSV files, a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is
                prefixed with `'`, so that spreadsheets do not run it as a formula; `data.json` keeps it as written.
                Raters saw only the briefs of their assigned exercises, numbered from 1 in their rating order.
                Match a brief number to that rater's `position` in `ratings.csv` (or `tables.ratings` in `data.json`).
                Free text on the briefs refers to these rater-specific numbers.

                """
                + sections;
    }

    /** The data the analysis reads: the study's exercises, the instrument, and every table's rows. */
    public static String data(LoadedStudy loaded, SurveyStore store, List<String> roles) {
        return data(loaded, tables(loaded, store, roles));
    }

    private static String data(LoadedStudy loaded, List<Table> tables) {
        var study = loaded.study();
        var exercises = study.exercises().stream()
                .map(entry -> new Row()
                        .with("code", entry.code())
                        .with("phase", entry.phase())
                        .with("id", loaded.idOf().get(entry.code()))
                        .with(
                                "sha256",
                                loaded.manifest().entry(entry.code()) == null
                                        ? null
                                        : loaded.manifest().entry(entry.code()).sha256()))
                .toList();
        var data = new LinkedHashMap<String, Object>();
        data.put(
                "study",
                new Row()
                        .with("id", study.id())
                        .with("title", study.title())
                        .with("ratings_per_exercise", study.ratingsPerExercise())
                        .with("exercises", exercises));
        data.put("instrument", loaded.instrument());
        var rows = new LinkedHashMap<String, Object>();
        tables.forEach(table -> rows.put(table.file().replaceFirst("\\.csv$", ""), table.rows()));
        data.put("tables", rows);
        return JsonFormat.write(data) + "\n";
    }

    /** The export the study team downloads: tidy CSV tables, the same data as JSON, and a codebook. */
    public static byte[] archive(LoadedStudy loaded, SurveyStore store, List<String> roles) {
        var tables = tables(loaded, store, roles);
        var files = new LinkedHashMap<String, String>();
        files.put("CODEBOOK.md", codebook(loaded, tables, roles));
        files.put("data.json", data(loaded, tables));
        for (var table : tables) {
            files.put(
                    table.file(),
                    Csv.write(table.columns().stream().map(Header::name).toList(), table.rows()));
        }
        var bytes = new ByteArrayOutputStream();
        try (var zip = new ZipOutputStream(bytes)) {
            for (var file : files.entrySet()) {
                zip.putNextEntry(new ZipEntry(file.getKey()));
                zip.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
        return bytes.toByteArray();
    }
}
