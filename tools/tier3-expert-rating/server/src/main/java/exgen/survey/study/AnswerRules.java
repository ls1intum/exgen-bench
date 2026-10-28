package exgen.survey.study;

import exgen.survey.study.Instrument.ChoiceItem;
import exgen.survey.study.Instrument.Detail;
import exgen.survey.study.Instrument.Item;
import exgen.survey.study.Instrument.MultiItem;
import exgen.survey.study.Instrument.Option;
import exgen.survey.study.Instrument.TextItem;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * The rules a section's answers must meet before they are stored, the same rules the browser app
 * applies in {@code shared/instrument.ts} before it lets a rater submit. The server is the one that
 * decides; the app only shows the issues early.
 */
public final class AnswerRules {
    private AnswerRules() {}

    /** Why an item's answer cannot be submitted yet, such as "is required". */
    public record Issue(String item, String message) {}

    /**
     * Every reason a section's answers cannot be submitted yet, item by item and in item order. An
     * empty list means the section is complete.
     */
    public static List<Issue> issues(List<Item> items, Map<String, Answer> answers) {
        var known = items.stream().map(Item::id).collect(java.util.stream.Collectors.toSet());
        var issues = new ArrayList<Issue>();
        for (var id : answers.keySet()) {
            if (!known.contains(id)) {
                issues.add(new Issue(id, "is not part of this section"));
            }
        }
        for (var item : items) {
            var message = issue(item, answers.get(item.id()), answers);
            if (message != null) {
                issues.add(new Issue(item.id(), message));
            }
        }
        return issues;
    }

    /** Answers reduced to the items of a section, with text trimmed and unselected details dropped. */
    public static Map<String, Answer> normalize(List<Item> items, Map<String, Answer> answers) {
        var normalized = new LinkedHashMap<String, Answer>();
        for (var item : items) {
            var answer = answers.get(item.id());
            if (answer == null) {
                continue;
            }
            switch (item) {
                case TextItem text -> {
                    if (filled(answer.text())) {
                        normalized.put(text.id(), new Answer(null, null, null, Text.trim(answer.text())));
                    }
                }
                case MultiItem multi -> {
                    var values = Objects.requireNonNullElse(answer.values(), List.<String>of());
                    var detail = detailOf(multi.options().stream()
                            .filter(option -> values.contains(option.value()))
                            .toList());
                    normalized.put(
                            multi.id(), new Answer(null, values, followUp(detail, answer), detailText(detail, answer)));
                }
                case ChoiceItem choice -> {
                    var detail = detailOf(choice.options().stream()
                            .filter(option -> Objects.equals(option.value(), answer.value()))
                            .toList());
                    normalized.put(
                            choice.id(),
                            new Answer(answer.value(), null, followUp(detail, answer), detailText(detail, answer)));
                }
            }
        }
        return normalized;
    }

    private static Optional<Detail> detailOf(List<Option> selected) {
        return selected.stream().map(Option::detail).filter(Objects::nonNull).findFirst();
    }

    private static String followUp(Optional<Detail> detail, Answer answer) {
        return detail.map(Detail::choices).isPresent() ? answer.choice() : null;
    }

    private static String detailText(Optional<Detail> detail, Answer answer) {
        return detail.isPresent() && filled(answer.text()) ? Text.trim(answer.text()) : null;
    }

    private static boolean filled(String text) {
        return text != null && !Text.trim(text).isEmpty();
    }

    private static boolean optionalNow(TextItem item, Map<String, Answer> answers) {
        if (!item.required()) {
            return true;
        }
        var condition = item.optionalWhen();
        var answer = condition == null ? null : answers.get(condition.item());
        return answer != null && Objects.equals(answer.value(), condition.value());
    }

    private static String issue(Item item, Answer answer, Map<String, Answer> answers) {
        return switch (item) {
            case TextItem text -> {
                if (answer != null && (answer.value() != null || answer.values() != null)) {
                    yield "takes only text";
                }
                yield filled(answer == null ? null : answer.text()) || optionalNow(text, answers)
                        ? null
                        : "is required";
            }
            case MultiItem multi -> multiIssue(multi, answer);
            case ChoiceItem choice -> choiceIssue(choice, answer);
        };
    }

    private static String multiIssue(MultiItem item, Answer answer) {
        var selected = answer == null || answer.values() == null ? List.<String>of() : answer.values();
        if (selected.isEmpty()) {
            return "needs at least one option";
        }
        var options = new ArrayList<Option>();
        for (var value : selected) {
            var option = item.options().stream()
                    .filter(candidate -> Objects.equals(candidate.value(), value))
                    .findFirst();
            if (option.isEmpty()) {
                return "has an option that does not exist";
            }
            options.add(option.get());
        }
        Set<String> distinct = new HashSet<>(selected);
        if (distinct.size() != selected.size()) {
            return "has an option twice";
        }
        if (selected.size() > 1 && options.stream().anyMatch(Option::exclusive)) {
            return "combines an exclusive option with another";
        }
        var detail = options.stream()
                .map(Option::detail)
                .filter(candidate -> candidate != null && candidate.required())
                .findFirst();
        return detail.isPresent() && !filled(answer.text())
                ? "needs “" + detail.get().label() + "”"
                : null;
    }

    private static String choiceIssue(ChoiceItem item, Answer answer) {
        if (answer == null || answer.value() == null) {
            return "is required";
        }
        var option = item.options().stream()
                .filter(candidate -> Objects.equals(candidate.value(), answer.value()))
                .findFirst();
        if (option.isEmpty()) {
            return "has an option that does not exist";
        }
        var detail = option.get().detail();
        if (detail != null && detail.choices() != null) {
            if (detail.choices().stream().noneMatch(choice -> choice.value().equals(answer.choice()))) {
                return "needs one of the follow-up choices";
            }
        } else if (answer.choice() != null) {
            return "has a follow-up choice the option does not offer";
        }
        if (detail != null && detail.required() && !filled(answer.text())) {
            return "needs “" + detail.label() + "”";
        }
        return null;
    }
}
