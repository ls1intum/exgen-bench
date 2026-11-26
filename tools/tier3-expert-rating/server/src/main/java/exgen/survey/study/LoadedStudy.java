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
        Instrument mainInstrument,
        Manifest manifest,
        Map<String, ObjectNode> exercises,
        Map<String, String> idOf) {

    public Instrument instrumentFor(Study.Role role) {
        return mainInstrument != null && (role.mainCohort() || role == Study.Role.REHEARSAL)
                ? mainInstrument
                : instrument;
    }

    /** Cut an exercise down to the material a step has opened, so later material never leaves the server. */
    public static ObjectNode viewOf(ObjectNode exercise, List<String> open) {
        return viewOf(exercise, open, true);
    }

    public static ObjectNode viewOf(ObjectNode exercise, List<String> open, boolean includeFacts) {
        var view = JsonNodeFactory.instance.objectNode();
        view.set("id", exercise.get("id"));
        view.set("phase", exercise.get("phase"));
        if (includeFacts) {
            view.set("facts", exercise.get("facts"));
        }
        for (var material : open) {
            if (exercise.has(material)) {
                if (!includeFacts && material.equals("statement") && !open.contains("tests")) {
                    // The builder labels untested tasks. That is test evidence, which opens in C.
                    view.put("statement", exercise.path("statement").asString().replace("[task:untested]", "[task]"));
                } else {
                    view.set(material, exercise.get(material));
                }
            }
        }
        return view;
    }
}
