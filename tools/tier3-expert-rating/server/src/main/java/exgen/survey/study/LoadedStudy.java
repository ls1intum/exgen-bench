package exgen.survey.study;

import java.util.List;
import java.util.Map;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Everything the server runs on, loaded once and verified against the frozen manifest.
 *
 * @param exercises the built exercises by code; codes are visible only to the study team
 * @param idOf the random ID raters see, by code
 */
public record LoadedStudy(
        Study study,
        Instrument instrument,
        Manifest manifest,
        Map<String, ObjectNode> exercises,
        Map<String, String> idOf) {

    /** Cut an exercise down to the material a step has opened, so later material never leaves the server. */
    public static ObjectNode viewOf(ObjectNode exercise, List<String> open) {
        var view = JsonNodeFactory.instance.objectNode();
        for (var field : List.of("id", "phase", "facts")) {
            view.set(field, exercise.get(field));
        }
        for (var material : open) {
            if (exercise.has(material)) {
                view.set(material, exercise.get(material));
            }
        }
        return view;
    }
}
