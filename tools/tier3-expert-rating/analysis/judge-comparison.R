# Compare a single staged Judge run and the study's completed planned ratings.
judge <- jsonlite::fromJSON(judge_input, simplifyVector = FALSE)
manifest <- judge$manifest
if (!identical(manifest$rubric_version, instrument$version)) {
  stop("The staged Judge rubric version does not match the survey export")
}
if (length(conditions) && !identical(manifest$presentation$findings, findings_presentation)) {
  stop("The staged Judge findings presentation does not match the survey export")
}

frozen <- data.frame(
  id = vapply(study$exercises, function(entry) if (is.null(entry$id)) NA_character_ else entry$id, ""),
  hash = vapply(study$exercises, function(entry) if (is.null(entry$sha256)) NA_character_ else entry$sha256, ""),
  code = exercises
)
frozen <- frozen[!is.na(frozen$id), , drop = FALSE]
if (anyDuplicated(frozen$id)) stop("The export has conflicting digests for an exercise")
judged_ids <- vapply(manifest$exercises, function(entry) entry$id, "")
if (!length(judged_ids)) stop("The staged Judge run contains no exercises")
if (anyDuplicated(judged_ids)) stop("The staged Judge run repeats an exercise")
for (entry in manifest$exercises) {
  expected <- frozen$hash[match(entry$id, frozen$id)]
  if (length(expected) != 1 || is.na(expected) || !identical(entry$archive_sha256, expected)) {
    stop("The Judge did not use the frozen exercise file in this export: ", entry$id)
  }
}

rows <- judge$rows
keys <- character()
for (row in rows) {
  if (!identical(row$rubric_version, instrument$version) ||
      !identical(row$judge_version, manifest$judge_version) || !(row$exercise_id %in% judged_ids) ||
      !(row$item_id %in% exercise_items) || !identical(row$part, catalogue[[row$item_id]]$part) ||
      !(row$status %in% c("answered", "invalid_output", "model_error"))) {
    stop("The staged Judge rows do not match the run and survey instrument")
  }
  key <- paste(row$exercise_id, row$item_id, sep = "/")
  keys <- c(keys, key)
  if (row$status != "answered" && !is.null(row$answer)) {
    stop("The staged Judge has an answer for a call that did not answer: ", key)
  }
  value <- as.character(row$answer$value)
  if (identical(row$status, "answered") &&
      (length(value) != 1 || !(value %in% catalogue[[row$item_id]]$values))) {
    stop("The staged Judge has an unknown or missing answer for ", key)
  }
}
if (anyDuplicated(keys)) stop("The staged Judge repeats an item for an exercise")
if (!all(as.vector(outer(judged_ids, exercise_items, paste, sep = "/")) %in% keys)) {
  stop("The staged Judge run is missing item rows; regenerate the run")
}
names(rows) <- keys

emit(
  "## SQ4: LLM judge", "",
  paste0("Staged run `", manifest$judge_version, "`, rubric SHA-256 `", manifest$rubric_sha256, "`. ",
    "Frozen exercise files matching this export: ", length(judged_ids), "."),
  paste0("Judge item rows SHA-256 `", manifest$rows_sha256, "`."),
  "",
  "Exact agreement uses the same exercises for both columns. Each exercise needs two assessable",
  "planned human ratings and an assessable Judge rating for that item. Judge–human results count",
  "the two original human judgments separately. The all-answers column also includes Cannot",
  "assess and N/A. Missing or failed answers have their own counts. Reviewers alone answer",
  "FIND and FLAG about their use of the report.", ""
)

archive_ids <- setNames(frozen$id, frozen$code)
by_item <- lapply(exercise_items, function(item) {
  lapply(exercises, function(code) {
    own <- by_exercise[[code]]
    id <- unname(archive_ids[code])
    row <- rows[[paste(id, item, sep = "/")]]
    pick <- function(column_name, i) if (nrow(own) >= i) as.character(column(own, column_name)[i]) else NA_character_
    model <- if (length(row$answer$value)) as.character(row$answer$value) else NA_character_
    data.frame(Exercise = code, Item = item, Reviewer1 = pick("rater_id", 1),
      Human1 = pick(item, 1), Reviewer2 = pick("rater_id", 2), Human2 = pick(item, 2),
      Judge = model, Status = if (is.null(row)) "missing_run" else row$status,
      `Evidence issues` = paste(unlist(row$evidence_issues), collapse = "; "),
      check.names = FALSE)
  })
})
comparisons <- do.call(rbind, unlist(by_item, recursive = FALSE))
write.csv(comparisons, file.path(output, "tables", "judge-by-exercise.csv"), na = "", row.names = FALSE)
assessable <- function(value) !is.na(value) & !(value %in% c(CANNOT, NOT_APPLICABLE))
summary <- do.call(rbind, lapply(exercise_items, function(item) {
  own <- comparisons[comparisons$Item == item, , drop = FALSE]
  comparable <- own$Status %in% "answered" & assessable(own$Judge) &
    assessable(own$Human1) & assessable(own$Human2)
  n <- sum(comparable)
  selected <- own[comparable, , drop = FALSE]
  first <- !is.na(own$Judge) & !is.na(own$Human1)
  second <- !is.na(own$Judge) & !is.na(own$Human2)
  exact_all <- sum(own$Judge[first] == own$Human1[first]) + sum(own$Judge[second] == own$Human2[second])
  data.frame(Item = item, Exercises = n,
    `Human–human exact` = count_share(sum(selected$Human1 == selected$Human2), n),
    `Judge–human exact` = count_share(sum(selected$Judge == selected$Human1) +
      sum(selected$Judge == selected$Human2), 2L * n),
    `Judge–human exact, all answers` = count_share(exact_all, sum(first) + sum(second)),
    `Judge locator issues` = sum(own$Status == "answered" & nzchar(own$`Evidence issues`)),
    `Judge cannot assess` = sum(own$Judge %in% CANNOT),
    `Judge N/A` = sum(own$Judge %in% NOT_APPLICABLE),
    `Judge no run` = sum(own$Status == "missing_run"),
    `Judge failed` = sum(!(own$Status %in% c("answered", "missing_run"))), check.names = FALSE)
}))
table_out(summary, "judge-agreement")

emit(
  "Readiness disagreement by stage. A comparison across 3/4 signals a different decision about",
  "whether the exercise needs substantive changes. The table counts each Judge–reviewer comparison.",
  ""
)
by_readiness <- do.call(rbind, lapply(c("RD1", "RD2"), function(item) {
  whole <- comparisons[comparisons$Item == item, , drop = FALSE]
  model <- rep(level_of(whole$Judge), 2)
  human <- c(level_of(whole$Human1), level_of(whole$Human2))
  usable <- !is.na(model) & !is.na(human)
  model <- model[usable]
  human <- human[usable]
  data.frame(Item = item, Comparisons = sum(usable),
    `Within one level` = count_share(sum(abs(model - human) <= 1), sum(usable)),
    `Judge 4–5, reviewer 1–3` = sum(model >= 4 & human <= 3),
    `Judge 1–3, reviewer 4–5` = sum(model <= 3 & human >= 4), check.names = FALSE)
}))
table_out(by_readiness, "judge-readiness")
emit(
  "The exercise table retains both human ratings, the Judge's answer or failure, and locator",
  "problems. A valid locator can still support an incorrect interpretation. Verify grading",
  "examples and apparent findings separately against the evidence.", ""
)
