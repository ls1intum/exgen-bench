package exgen.survey.study;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Loads a built study and the instrument it asks with. Every exercise file must match the digest
 * recorded when it was built, so material a rater sees can never have changed after the study was
 * frozen; anything the server cannot run on stops it before the first request.
 */
public final class StudyLoader {
    /** Reads YAML with its anchors and aliases resolved, which Jackson's YAML tree parser leaves as names. */
    private static final Load YAML_LOADER =
            new Load(LoadSettings.builder().setAllowDuplicateKeys(false).build());

    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();
    private static final Set<String> EXERCISE_FIELDS = Set.of(
            "schema_version", "id", "phase", "brief", "statement", "facts", "template", "diff", "tests", "findings");

    private StudyLoader() {}

    /** The instrument with its calibration items resolved and its placeholders filled in. */
    public static Instrument loadInstrument(Path path) {
        var source = (ObjectNode) readYaml(path);
        var background = items(source, "background");
        var questionnaire = new ArrayList<JsonNode>();
        source.get("questionnaire")
                .get("parts")
                .forEach(part -> part.get("items").forEach(questionnaire::add));
        var exit = items(source, "exit");
        var ids = new HashSet<String>();
        for (var section : List.of(background, questionnaire, exit)) {
            for (var item : section) {
                if (!ids.add(item.get("id").asString())) {
                    throw new IllegalStateException(
                            "instrument item " + item.get("id").asString() + " is defined twice");
                }
            }
            for (var item : section) {
                var condition = item.get("optional_when");
                if (condition != null
                        && section.stream().noneMatch(other -> other.get("id").equals(condition.get("item")))) {
                    throw new IllegalStateException(item.get("id").asString() + " depends on "
                            + condition.get("item").asString() + ", which is not in its section");
                }
            }
        }
        var calibration = (ObjectNode) source.get("calibration");
        var resolved = calibration.arrayNode();
        for (var id : calibration.get("items")) {
            resolved.add(questionnaire.stream()
                    .filter(item -> item.get("id").equals(id))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException(
                            "calibration item " + id.asString() + " is not a questionnaire item"))
                    .deepCopy());
        }
        calibration.set("items", resolved);
        var rule = Text.trim(source.get("materiality_rule").asString());
        for (var page : source.get("onboarding").get("pages")) {
            ((ObjectNode) page).put("body", page.get("body").asString().replace("{materiality_rule}", rule));
        }
        return JSON.treeToValue(source, Instrument.class);
    }

    /**
     * Load the built study in {@code directory} with the instrument at {@code instrumentPath}, and
     * verify that the server can run it as frozen.
     */
    public static LoadedStudy load(Path directory, Path instrumentPath) {
        var study = JSON.treeToValue(readYaml(directory.resolve("study.yaml")), Study.class);
        var instrument = loadInstrument(instrumentPath);
        if (!study.instrumentVersion().equals(instrument.version())) {
            throw new IllegalStateException("the study was designed for instrument version " + study.instrumentVersion()
                    + ", but this server has version " + instrument.version());
        }
        var exercisesDirectory = directory.resolve("exercises");
        if (!Files.exists(exercisesDirectory.resolve("manifest.json"))) {
            throw new IllegalStateException("exercises not built yet; run exgen survey build " + directory);
        }
        var manifest = builtWith(directory, () -> {
            var parsed = JSON.treeToValue(read(JSON, exercisesDirectory.resolve("manifest.json")), Manifest.class);
            if (!"1".equals(parsed.schemaVersion())) {
                throw new IllegalStateException("unknown manifest version");
            }
            return parsed;
        });
        if (!manifest.studyId().equals(study.id())) {
            throw new IllegalStateException(
                    "the exercises were built for study " + manifest.studyId() + ", not " + study.id());
        }
        var exercises = new LinkedHashMap<String, ObjectNode>();
        var idOf = new LinkedHashMap<String, String>();
        for (var entry : manifest.exercises()) {
            var bytes = readBytes(exercisesDirectory.resolve(entry.id() + ".json"));
            if (!sha256(bytes).equals(entry.sha256())) {
                throw new IllegalStateException(
                        "exercise " + entry.code() + " (" + entry.id() + ") changed after it was built");
            }
            exercises.put(entry.code(), builtWith(directory, () -> exercise(bytes)));
            idOf.put(entry.code(), entry.id());
        }
        var problems = new ArrayList<String>();
        var codes = Stream.concat(
                        study.exercises().stream().map(Study.ExerciseEntry::code),
                        Stream.of(study.calibration().code()))
                .toList();
        var missing =
                codes.stream().filter(code -> !exercises.containsKey(code)).toList();
        if (!missing.isEmpty()) {
            problems.add("exercises not built yet: " + String.join(", ", missing) + "; run exgen survey build");
        }
        var stale = manifest.exercises().stream()
                .map(Manifest.Entry::code)
                .filter(code -> !codes.contains(code))
                .toList();
        if (!stale.isEmpty()) {
            problems.add("built exercises are no longer in study.yaml: " + String.join(", ", stale));
        }
        for (var rater : study.raters()) {
            var unknown = rater.exercises().stream()
                    .filter(code -> study.exercise(code) == null)
                    .toList();
            if (!unknown.isEmpty()) {
                problems.add(rater.id() + " is assigned unknown exercises: " + String.join(", ", unknown));
            }
        }
        for (var item : instrument.calibration().items()) {
            var reference = study.calibration().reference().get(item.id());
            if (reference == null) {
                problems.add("the calibration has no reference answer for " + item.id());
                continue;
            }
            var answers = new LinkedHashMap<String, Answer>();
            answers.put(item.id(), reference.answer());
            for (var issue : AnswerRules.issues(List.of(item), answers)) {
                problems.add("the calibration reference answer for " + issue.item() + " " + issue.message());
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("the study cannot be served; run exgen survey check " + directory + ":\n"
                    + String.join("\n", problems));
        }
        return new LoadedStudy(study, instrument, manifest, exercises, idOf);
    }

    private static ObjectNode exercise(byte[] bytes) {
        var node = (ObjectNode) JSON.readTree(bytes);
        if (!node.path("schema_version").asString("").equals("1")
                || !EXERCISE_FIELDS.containsAll(node.propertyNames())) {
            throw new IllegalStateException("unknown exercise format");
        }
        return node;
    }

    /** A file in the format this server reads; a file another version wrote is refused with the way out. */
    private static <T> T builtWith(Path directory, java.util.function.Supplier<T> parse) {
        try {
            return parse.get();
        } catch (JacksonException | IllegalStateException | ClassCastException error) {
            throw new IllegalStateException(
                    "the exercises in " + directory
                            + " were built by another version of exgen-bench; rebuild them with: exgen survey build --rebuild "
                            + directory,
                    error);
        }
    }

    private static List<JsonNode> items(ObjectNode source, String section) {
        var items = new ArrayList<JsonNode>();
        ((ArrayNode) source.get(section).get("items")).forEach(items::add);
        return items;
    }

    private static JsonNode readYaml(Path path) {
        return JSON.valueToTree(YAML_LOADER.loadFromString(new String(readBytes(path), StandardCharsets.UTF_8)));
    }

    private static JsonNode read(ObjectMapper mapper, Path path) {
        return mapper.readTree(readBytes(path));
    }

    private static byte[] readBytes(Path path) {
        try {
            return Files.readAllBytes(path);
        } catch (IOException error) {
            throw new UncheckedIOException("cannot read " + path, error);
        }
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
