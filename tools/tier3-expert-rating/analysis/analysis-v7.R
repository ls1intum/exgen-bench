# The analysis of instrument version 7 (study protocol, "Studienprotokoll, Judge und Freigabe"),
# sourced by analysis.R once it has read data.json and checked the findings presentation. It uses
# analysis.R's helpers (as_frame, column, emit, table_out, share, fixed) and leaves the report in
# `report`; analysis.R writes it.
#
# The study rates twelve chosen drafts twice each, so every result is a count on this finite set:
# no intervals, tests, models, pooled agreement or differences of readiness levels. Each item keeps
# its own categories; "na" (not applicable) and "cannot_assess" stay categories of their own and are
# never recoded into agreement or quality.

parts_v7 <- list(A = "SPEC", B = c("GOAL", "SUPPORT"), C = c("FEEDBACK", "RD1"),
  D = c("RD2", "FIND", "FLAG"))
items_v7 <- unlist(parts_v7, use.names = FALSE)
exercise_items <- setdiff(items_v7, c("FIND", "FLAG"))
CANNOT <- "cannot_assess"
NOT_APPLICABLE <- "na"
LEVELS <- as.character(5:1)
GROUPS <- c("both 4–5", "split", "both 1–3", "incomplete")
CLASS_NAMES <- c(ready = "At most editorial (4–5)", local = "Usable with local changes (3)",
  major = "Major revision or replacement (1–2)")

# ---- Instrument ---------------------------------------------------------------------------------

catalogue <- list()
for (part in instrument$questionnaire$parts) {
  for (item in part$items) {
    catalogue[[item$id]] <- list(
      part = part$id, kind = item$kind,
      values = vapply(item$options, function(option) as.character(option$value), ""),
      labels = vapply(item$options, function(option) as.character(option$label), "")
    )
  }
}
for (part in names(parts_v7)) {
  for (id in parts_v7[[part]]) {
    entry <- catalogue[[id]]
    if (is.null(entry) || entry$part != part || entry$kind != "choice") {
      stop("Instrument ", instrument$version, " is not version 7: ", id,
        " must be a choice item of Part ", part)
    }
  }
}
for (id in c("RD1", "RD2")) {
  if (!setequal(catalogue[[id]]$values, c(LEVELS, CANNOT))) {
    stop("Instrument ", instrument$version, ": ", id, " must offer the levels 1 to 5 and ", CANNOT)
  }
}
if (!setequal(catalogue$FIND$values, c("changed", "confirmed", "no_effect", NOT_APPLICABLE, CANNOT))) {
  stop("Instrument ", instrument$version, ": FIND must offer changed, confirmed, no_effect, na and ", CANNOT)
}
label_of <- function(id, value) {
  labels <- catalogue[[id]]$labels[match(value, catalogue[[id]]$values)]
  ifelse(is.na(labels), value, labels)
}

# ---- Ratings ------------------------------------------------------------------------------------

exercises <- vapply(study$exercises, function(entry) entry$code, "")
phases <- setNames(vapply(study$exercises, function(entry) entry$phase, ""), exercises)

ratings <- as_frame(data$tables$ratings)
text_of <- function(name) as.character(column(ratings, name))
complete <- column(ratings, "complete") %in% TRUE
assignment <- text_of("assignment")
rater <- text_of("rater_id")
code <- text_of("exercise_code")
replaces <- text_of("replaces")
version_of <- text_of("instrument_version")

# Answers of another instrument version have other columns; the report never pools them.
foreign <- complete & !is.na(version_of) & version_of != as.character(instrument$version)
if (any(foreign)) {
  stop("Cannot pool instrument versions: ", sum(foreign), " completed ratings use version ",
    paste(sort(unique(version_of[foreign])), collapse = ", "), ", the export version ",
    instrument$version, ". Analyse each version from its own export.")
}
for (id in items_v7) {
  values <- text_of(id)
  invalid <- !is.na(values) & !(values %in% catalogue[[id]]$values)
  if (any(invalid)) {
    stop(id, " holds values the instrument does not offer: ",
      paste(sort(unique(values[invalid])), collapse = ", "))
  }
}
outside <- complete & !is.na(code) & !(code %in% exercises)
if (any(outside)) {
  stop("Completed ratings of exercises outside the study: ", paste(sort(unique(code[outside])), collapse = ", "))
}
if (!identical(as.integer(study$ratings_per_exercise), 2L)) {
  stop("The version 7 analysis compares planned pairs; the study plans ",
    study$ratings_per_exercise, " ratings per exercise")
}

# A planned place is filled by its main rater's complete rating, or else by the backup that stands in
# for that rater on the same exercise. A backup whose main rater also finished is not used.
main <- assignment %in% "planned" & text_of("role") %in% "main"
backup <- assignment %in% "backup"
superseded <- backup & complete & vapply(seq_len(nrow(ratings)), function(index) {
  !is.na(replaces[index]) && any(complete & main & rater %in% replaces[index] & code %in% code[index])
}, TRUE)
in_plan <- complete & (main | (backup & !superseded))
over <- table(code[in_plan])
if (any(over > 2)) {
  stop("More than two planned ratings for ", paste(names(over)[over > 2], collapse = ", "),
    "; record which rating fills each place before the analysis")
}
planned_rater <- ifelse(backup, replaces, rater)
if (any(in_plan & (is.na(planned_rater) | !nzchar(planned_rater)))) {
  stop("A completed backup is missing the planned rater it replaces")
}
plan_keys <- paste(code[in_plan], planned_rater[in_plan], sep = "/")
if (anyDuplicated(plan_keys)) {
  stop("More than one rating fills the planned place ", plan_keys[duplicated(plan_keys)][[1]])
}
started <- !complete & (main | backup)

order_rows <- function(selected) {
  rows <- ratings[selected, , drop = FALSE]
  rows[order(match(text_of("exercise_code")[selected], exercises), text_of("rater_id")[selected]), , drop = FALSE]
}
planned <- order_rows(in_plan)
tie <- order_rows(complete & assignment %in% "tie_breaker")
places <- 2L * length(exercises)
answers_of <- function(frame, id) as.character(column(frame, id))
level_of <- function(values) suppressWarnings(as.integer(ifelse(values %in% LEVELS, values, NA)))
class_of <- function(levels) {
  ifelse(is.na(levels), NA, ifelse(levels >= 4, "ready", ifelse(levels == 3, "local", "major")))
}
count_share <- function(count, total) {
  if (total == 0) as.character(count) else paste0(count, " (", share(count / total), ")")
}
planned_code <- answers_of(planned, "exercise_code")
by_exercise <- lapply(setNames(exercises, exercises), function(entry) planned[planned_code == entry, , drop = FALSE])
pairs <- Filter(function(rows) nrow(rows) == 2, by_exercise)

# ---- Header -------------------------------------------------------------------------------------

emit(
  paste0("# ", study$title, ": analysis report"),
  "",
  paste0(
    "Generated by `tools/tier3-expert-rating/analysis/analysis.R` from `data.json` (SHA-256 `",
    input_sha256, "`). Do not edit this file; regenerate it with `exgen survey report`."
  ),
  "",
  paste0("- Study `", study$id, "`, instrument version ", instrument$version, "."),
  paste0(
    "- Findings presentation: `", findings_presentation, "`.",
    if (findings_presentation == "legacy-unversioned")
      " Historical layouts are unknown and may differ; this is not a confirmed homogeneous condition." else ""
  ),
  paste0(
    "- Planned places: ", places, " (", length(exercises), " exercises × 2). Complete: ", nrow(planned),
    ", of them ", sum(answers_of(planned, "assignment") %in% "backup"), " by backups standing in for a main rater."
  ),
  paste0(
    "- Not used: ", sum(started), " started but incomplete planned ratings; ", sum(superseded),
    " backup ratings whose main rater also finished; ", sum(complete & assignment %in% "additional"),
    " additional ratings."
  ),
  paste0("- Exercises with both planned ratings: ", length(pairs), " of ", length(exercises), "."),
  paste0("- Tie-breaker ratings: ", nrow(tie), "; shown beside the planned pair, never in its place."),
  paste0("- ", R.version.string, "."),
  "",
  "Every result is a count on these chosen exercises and their planned ratings. It describes them and",
  "does not generalise to other outputs of the pipeline, other models, courses, or learning. The",
  "report has no intervals, significance tests, models, pooled agreement, or differences of readiness",
  "levels. N/A and Cannot assess stay answers of their own.",
  ""
)

# ---- Answers ------------------------------------------------------------------------------------

emit(
  "## Answers", "",
  "Denominators per item. Places without a complete planned rating are missing ratings, not answers;",
  "Cannot assess and N/A are answers; the rest are assessable.", ""
)
coverage <- do.call(rbind, lapply(items_v7, function(id) {
  values <- answers_of(planned, id)
  data.frame(
    Item = id, Part = catalogue[[id]]$part, Places = places, Complete = nrow(planned),
    `Missing ratings` = places - nrow(planned), `No answer` = sum(is.na(values)),
    `Cannot assess` = sum(values %in% CANNOT), `N/A` = sum(values %in% NOT_APPLICABLE),
    Assessable = sum(!is.na(values) & !(values %in% c(CANNOT, NOT_APPLICABLE))),
    check.names = FALSE
  )
}))
table_out(coverage, "answers-coverage")

emit("Answers per item, in the instrument's order, as shares of the complete planned ratings.", "")
categories <- do.call(rbind, lapply(items_v7, function(id) {
  values <- answers_of(planned, id)
  entry <- catalogue[[id]]
  data.frame(
    Item = id, Answer = entry$values, Label = entry$labels,
    Ratings = vapply(entry$values, function(value) sum(values %in% value), 0L),
    Share = vapply(entry$values, function(value) {
      if (length(values) == 0) NA_character_ else share(mean(values %in% value))
    }, ""),
    check.names = FALSE, row.names = NULL
  )
}))
table_out(categories, "answers-items")

# ---- SQ1 ----------------------------------------------------------------------------------------

emit(
  "## SQ1: Ready for the course?", "",
  "Readiness on the five levels per course phase. The places count planned places of the phase; the",
  "classes keep the original thresholds (4–5, 3, 1–2) among the assessable ratings.", ""
)
phase_order <- unique(c(intersect(c("early", "middle", "late"), phases), unname(phases)))
distribution <- do.call(rbind, lapply(c("RD1", "RD2"), function(id) {
  do.call(rbind, lapply(c("all", phase_order), function(phase) {
    rows <- if (phase == "all") planned else planned[answers_of(planned, "phase") %in% phase, , drop = FALSE]
    values <- answers_of(rows, id)
    levels <- level_of(values)
    row <- data.frame(
      Item = id, Phase = phase,
      Places = 2L * (if (phase == "all") length(exercises) else sum(phases == phase)),
      Complete = nrow(rows), `Cannot assess` = sum(values %in% CANNOT),
      Assessable = sum(!is.na(levels)), check.names = FALSE
    )
    for (level in LEVELS) row[[level]] <- sum(values %in% level)
    for (name in names(CLASS_NAMES)) row[[CLASS_NAMES[[name]]]] <- sum(class_of(levels) %in% name)
    row
  }))
}))
table_out(distribution, "sq1-readiness-distribution")

emit(
  "Both original ratings per exercise, by rater ID, with the planned pair at the 3/4 threshold:",
  "both 4–5, split, both 1–3, or incomplete when a rating is missing or Cannot assess. A tie breaker",
  "is listed beside the pair and changes nothing in it; the classes column shows every class among",
  "the three, so 5/3/1 stays three classes and no majority is reported. The conservative column is",
  "an operational decision (the lower original RD2 when both are assessable), not a finding.",
  "The independent technical status and the coded repairs join by exercise code outside this report.",
  ""
)
show <- function(values) if (length(values) == 0) NA else paste(ifelse(values %in% CANNOT, "CA", values), collapse = ", ")
group_of <- function(levels) {
  if (length(levels) < 2 || any(is.na(levels))) "incomplete"
  else if (all(levels >= 4)) "both 4–5" else if (all(levels <= 3)) "both 1–3" else "split"
}
exercise_rows <- do.call(rbind, lapply(exercises, function(entry) {
  rows <- by_exercise[[entry]]
  rd2 <- answers_of(rows, "RD2")
  third <- answers_of(tie[answers_of(tie, "exercise_code") %in% entry, , drop = FALSE], "RD2")
  levels <- level_of(rd2)
  seen <- unique(class_of(level_of(c(rd2, third))))
  seen <- c(ready = "4–5", local = "3", major = "1–2")[names(CLASS_NAMES)[names(CLASS_NAMES) %in% seen]]
  data.frame(
    Exercise = entry, Phase = phases[[entry]], Ratings = nrow(rows),
    Backups = sum(answers_of(rows, "assignment") %in% "backup"),
    RD1 = show(answers_of(rows, "RD1")), RD2 = show(rd2), `RD2 at 3/4` = group_of(levels),
    `Tie breaker RD2` = show(third),
    `Classes incl. tie breaker` = if (length(seen) == 0) NA else paste(seen, collapse = " · "),
    `Conservative RD2 (operational)` = if (length(levels) == 2 && !any(is.na(levels))) as.character(min(levels)) else NA,
    check.names = FALSE
  )
}))
table_out(exercise_rows, "sq1-readiness-exercises")

# ---- SQ2 ----------------------------------------------------------------------------------------

emit(
  "## SQ2: How similarly do two instructors judge?", "",
  paste0(
    "Only exercises with both planned ratings count (", length(pairs), " of ", length(exercises),
    "). Agreement is calculated per exercise judgment. FIND and FLAG describe each reviewer’s own use of the report."
  ), ""
)
pair_values <- function(id) {
  if (length(pairs) == 0) return(data.frame(first = character(), second = character()))
  data.frame(
    first = vapply(pairs, function(rows) answers_of(rows, id)[1], ""),
    second = vapply(pairs, function(rows) answers_of(rows, id)[2], ""),
    stringsAsFactors = FALSE
  )
}
assessable <- function(values) !is.na(values) & !(values %in% c(CANNOT, NOT_APPLICABLE))
agreement <- do.call(rbind, lapply(exercise_items, function(id) {
  frame <- pair_values(id)
  both <- assessable(frame$first) & assessable(frame$second)
  same <- !is.na(frame$first) & !is.na(frame$second) & frame$first == frame$second
  data.frame(
    Item = id, Pairs = nrow(frame), `Same answer` = count_share(sum(same), nrow(frame)),
    `Both assessable` = sum(both), `Same among assessable` = count_share(sum(same & both), sum(both)),
    check.names = FALSE
  )
}))
table_out(agreement, "sq2-items")

emit("Answer combinations per item: how often each unordered pair of answers occurred.", "")
combinations <- do.call(rbind, lapply(exercise_items, function(id) {
  frame <- pair_values(id)
  if (nrow(frame) == 0) return(NULL)
  rank <- function(values) match(values, catalogue[[id]]$values)
  swap <- (rank(frame$first) > rank(frame$second)) %in% TRUE
  low <- ifelse(swap, frame$second, frame$first)
  high <- ifelse(swap, frame$first, frame$second)
  key <- paste(ifelse(is.na(low), "(no answer)", low), ifelse(is.na(high), "(no answer)", high), sep = " / ")
  counts <- table(factor(key, levels = unique(key[order(rank(low), rank(high))])))
  data.frame(Item = id, Answers = names(counts), Exercises = as.integer(counts), check.names = FALSE)
}))
if (is.null(combinations)) combinations <- data.frame(Item = character(), Answers = character(), Exercises = integer())
table_out(combinations, "sq2-item-combinations")

emit(
  "Readiness pairs where both ratings are assessable: same level, at most one level apart, and pairs",
  "on both sides of the 2/3 and the 3/4 threshold. Per exercise, the planned pair at the 3/4 threshold.",
  ""
)
readiness_agreement <- do.call(rbind, lapply(c("RD1", "RD2"), function(id) {
  frame <- pair_values(id)
  first <- level_of(frame$first)
  second <- level_of(frame$second)
  both <- !is.na(first) & !is.na(second)
  low <- pmin(first, second)[both]
  high <- pmax(first, second)[both]
  groups <- vapply(by_exercise, function(rows) group_of(level_of(answers_of(rows, id))), "")
  row <- data.frame(
    Item = id, Pairs = nrow(frame), `Both assessable` = sum(both),
    `Same level` = count_share(sum(low == high), sum(both)),
    `Within one level` = count_share(sum(high - low <= 1), sum(both)),
    `Across 2/3` = count_share(sum(low <= 2 & high >= 3), sum(both)),
    `Across 3/4` = count_share(sum(low <= 3 & high >= 4), sum(both)),
    check.names = FALSE
  )
  for (group in GROUPS) row[[paste("Exercises", group)]] <- sum(groups == group)
  row
}))
table_out(readiness_agreement, "sq2-readiness")

# ---- SQ3 ----------------------------------------------------------------------------------------

emit(
  "## SQ3: What did the automatic findings add?", "",
  "RD1 (rows) against submitted RD2 (columns) over the complete planned ratings. The first RD2",
  "choice comes before the option to reopen RD1. Reviewers can remember RD1 and revise RD2 after",
  "reopening it. A change in this fixed sequence combines new evidence with a second look.",
  ""
)
transition_values <- c(LEVELS, CANNOT)
rd1 <- answers_of(planned, "RD1")
rd2 <- answers_of(planned, "RD2")
transition <- do.call(rbind, lapply(transition_values, function(value) {
  row <- data.frame(RD1 = if (value == CANNOT) "Cannot assess" else value, check.names = FALSE)
  for (target in transition_values) {
    row[[if (target == CANNOT) "Cannot assess" else target]] <- sum(rd1 %in% value & rd2 %in% target)
  }
  row$Total <- sum(rd1 %in% value)
  row
}))
table_out(transition, "sq3-readiness-transition")

direction <- function(from, to) {
  first <- level_of(from)
  second <- level_of(to)
  ifelse(is.na(first) | is.na(second), "not comparable",
    ifelse(second < first, "lower", ifelse(second > first, "higher", "same")))
}
directions <- direction(rd1, rd2)
emit(paste0(
  "RD2 against RD1: ", sum(directions == "same"), " same, ", sum(directions == "lower"), " lower, ",
  sum(directions == "higher"), " higher, ", sum(directions == "not comparable"),
  " not comparable (a rating missing or Cannot assess)."
), "")

position <- answers_of(planned, "position")
positions <- ifelse(is.na(position), "Unknown", ifelse(position == "1", "First", "Later"))
by_position <- table(factor(positions, levels = c("First", "Later", "Unknown")),
  factor(directions, levels = c("lower", "same", "higher", "not comparable")))
emit("Readiness changes by exercise position. Earlier exercises may prime later reviews.", "")
table_out(data.frame(Position = rownames(by_position), unclass(by_position), check.names = FALSE),
  "sq3-by-position")

events <- as_frame(data$tables$events)
event_target <- answers_of(events, "target")
read_prior <- grepl("^prior-decision:", event_target)
record <- events[read_prior, , drop = FALSE]
record <- record[order(answers_of(record, "at")), , drop = FALSE]
event_key <- function(raters, steps) paste(raters, steps, sep = "/")
keys <- event_key(answers_of(record, "rater_id"), answers_of(record, "step"))
steps <- answers_of(planned, "part_d_step")
lookup <- match(event_key(answers_of(planned, "rater_id"), steps), keys)
lookup[is.na(steps)] <- NA_integer_
seen_value <- sub("^prior-decision:", "", answers_of(record, "target")[lookup])
seen <- !is.na(seen_value)
emit(paste0(
  "Recorded openings of the earlier decision: ", sum(seen), " planned ratings. Of these, ",
  sum(seen & !is.na(rd2) & rd2 != seen_value), " submitted a different RD2 choice from the one",
  " recorded at the first opening. Interaction events can be missed."
), "")

emit(
  "FIND by the direction from RD1 to RD2. FIND is relative to the rater's own earlier decision; a",
  "changed fix can leave the level unchanged.", ""
)
find <- answers_of(planned, "FIND")
find_rows <- do.call(rbind, lapply(catalogue$FIND$values, function(value) {
  selected <- find %in% value
  data.frame(
    FIND = value, Label = label_of("FIND", value),
    `RD2 lower` = sum(selected & directions == "lower"), `RD2 same` = sum(selected & directions == "same"),
    `RD2 higher` = sum(selected & directions == "higher"),
    `Not comparable` = sum(selected & directions == "not comparable"), Total = sum(selected),
    check.names = FALSE
  )
}))
table_out(find_rows, "sq3-find")

emit(
  "FLAG records whether a reviewer found a result misleading for their repair decision.",
  "Its counts are in the answers tables. The audit separately checks whether each finding holds up.", ""
)

texts <- intersect(
  c(grep("_text$", names(planned), value = TRUE), names(Filter(function(entry) entry$kind == "text", catalogue))),
  names(planned)
)
coded <- sum(vapply(texts, function(name) sum(!is.na(planned[[name]]) & nzchar(planned[[name]])), 0))
emit(
  paste0(
    "Free texts for coding: ", coded, " answers (repairs, locations, findings named, flags). Two researchers",
    " code them, and the authors audit the individual findings, outside this report."
  ), ""
)

if (is.null(judge_input)) {
  emit("## SQ4: LLM judge", "", "No staged Judge run supplied. Use `exgen survey report --judge DIR` for the comparison.", "")
} else {
  source(file.path(dirname(normalizePath(script)), "judge-comparison.R"))
}

# ---- End-of-session debrief ----------------------------------------------------------------------

exits <- as_frame(data$tables$exit)
feedback_ids <- c("QCLARITY", "MATERIAL")
feedback_items <- Filter(function(item) item$id %in% feedback_ids && identical(item$kind, "choice"),
  instrument$exit$items)
if (!setequal(vapply(feedback_items, function(item) item$id, ""), feedback_ids)) {
  stop("The version 7 questionnaire must include the two survey feedback questions")
}
feedback <- do.call(rbind, lapply(feedback_items, function(item) {
  values <- vapply(item$options, function(option) as.character(option$value), "")
  labels <- vapply(item$options, function(option) option$label, "")
  answers <- answers_of(exits, item$id)
  missing <- is.na(answers) | answers == ""
  if (any(!missing & !answers %in% values)) {
    stop("The survey feedback for ", item$id, " includes unknown choices")
  }
  data.frame(
    Item = item$id, Choice = c(values, "blank"), Label = c(labels, "Left blank"),
    Count = c(vapply(values, function(value) sum(answers %in% value), 0L), sum(missing)),
    check.names = FALSE
  )
}))
comments <- answers_of(exits, "SURVEYFB")
emit(
  "## Survey feedback", "",
  paste0(nrow(exits), " submitted closing pages. Questions could be left blank."),
  "Counts describe reviewers’ experience of the survey.",
  paste0("Optional comments received: ", sum(!is.na(comments) & nzchar(trimws(comments))), "."), ""
)
table_out(feedback, "survey-feedback")

# ---- Time ---------------------------------------------------------------------------------------

emit(
  "## Time", "",
  "Median minutes from opening a part's material to submitting it, over every complete rating in",
  "this export, and from consent to the last page for every rater who finished. The protocol aims",
  "at about 75–85 active minutes for a session of three exercises.", ""
)
rated <- ratings[complete, , drop = FALSE]
seconds <- vapply(c("A", "B", "C", "D"), function(part) {
  as.numeric(column(rated, paste0("seconds_", part)))
}, numeric(nrow(rated)))
seconds <- matrix(seconds, nrow = nrow(rated), ncol = 4)
raters <- as_frame(data$tables$raters)
consented <- column(raters, "consented_at")[match(column(exits, "rater_id"), column(raters, "rater_id"))]
session <- as.numeric(difftime(
  as.POSIXct(column(exits, "submitted_at"), format = "%Y-%m-%dT%H:%M:%OS", tz = "UTC"),
  as.POSIXct(consented, format = "%Y-%m-%dT%H:%M:%OS", tz = "UTC"),
  units = "mins"
))
median_minutes <- function(values) {
  if (all(is.na(values))) NA_character_ else fixed(median(values, na.rm = TRUE), 1)
}
timing <- data.frame(
  Span = c(paste("Part", c("A", "B", "C", "D")), "Exercise", "Session"),
  Count = c(rep(nrow(rated), 5), sum(!is.na(session))),
  Minutes = c(
    vapply(1:4, function(index) median_minutes(seconds[, index] / 60), ""),
    median_minutes(rowSums(seconds) / 60),
    median_minutes(session)
  ),
  check.names = FALSE
)
table_out(timing, "time")
