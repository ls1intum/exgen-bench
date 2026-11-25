# Compare a single staged Judge run and the study's completed planned ratings.
judge <- jsonlite::fromJSON(judge_input, simplifyVector = FALSE)
manifest <- judge$manifest
if (!identical(manifest$rubric_version, instrument$version)) {
  stop("The staged Judge rubric version does not match the survey export")
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
      !(row$item_id %in% c(items_v7, "FLAG")) || !identical(row$part, catalogue[[row$item_id]]$part) ||
      !(row$status %in% c("answered", "invalid_output", "model_error", "unavailable", "not_answered"))) {
    stop("The staged Judge rows do not match the run and survey instrument")
  }
  key <- paste(row$exercise_id, row$item_id, sep = "/")
  keys <- c(keys, key)
  value <- as.character(row$answer$value)
  if (row$item_id %in% items_v7 && identical(row$status, "answered") &&
      (length(value) != 1 || !(value %in% catalogue[[row$item_id]]$values))) {
    stop("The staged Judge has an unknown or missing answer for ", key)
  }
}
if (anyDuplicated(keys)) stop("The staged Judge repeats an item for an exercise")
if (!all(as.vector(outer(judged_ids, items_v7, paste, sep = "/")) %in% keys)) {
  stop("The staged Judge run is missing item rows; regenerate the run")
}
names(rows) <- keys

emit(
  "## SQ4: LLM judge", "",
  paste0("Staged run `", manifest$judge_version, "`, rubric SHA-256 `", manifest$rubric_sha256, "`. ",
    "Frozen exercise files matching this export: ", length(judged_ids), "."),
  "",
  "Exact agreement uses the same exercises for both columns. Each exercise needs two assessable",
  "planned human ratings and an assessable Judge rating for that item. Judge–human results count",
  "the two original human judgments separately. FIND is relative to each reviewer's earlier",
  "decision and is listed for inspection outside the agreement summary.", ""
)

archive_ids <- setNames(frozen$id, frozen$code)
by_item <- lapply(items_v7, function(item) {
  lapply(exercises, function(code) {
    own <- by_exercise[[code]]
    id <- unname(archive_ids[code])
    row <- rows[[paste(id, item, sep = "/")]]
    pick <- function(column_name, i) if (nrow(own) >= i) as.character(column(own, column_name)[i]) else NA_character_
    model <- if (length(row$answer$value)) as.character(row$answer$value) else NA_character_
    data.frame(Exercise = code, Item = item, Reviewer1 = pick("rater_id", 1),
      Human1 = pick(item, 1), Reviewer2 = pick("rater_id", 2), Human2 = pick(item, 2),
      Judge = model, Status = if (is.null(row)) "missing_run" else row$status,
      check.names = FALSE)
  })
})
comparisons <- do.call(rbind, unlist(by_item, recursive = FALSE))
write.csv(comparisons, file.path(output, "tables", "judge-by-exercise.csv"), na = "", row.names = FALSE)
assessable <- function(value) !is.na(value) & !(value %in% c(CANNOT, NOT_APPLICABLE))
summary <- do.call(rbind, lapply(setdiff(items_v7, "FIND"), function(item) {
  own <- comparisons[comparisons$Item == item, , drop = FALSE]
  comparable <- own$Status %in% "answered" & assessable(own$Judge) &
    assessable(own$Human1) & assessable(own$Human2)
  n <- sum(comparable)
  selected <- own[comparable, , drop = FALSE]
  data.frame(Item = item, Exercises = n,
    `Human–human exact` = count_share(sum(selected$Human1 == selected$Human2), n),
    `Judge–human exact` = count_share(sum(selected$Judge == selected$Human1) +
      sum(selected$Judge == selected$Human2), 2L * n),
    `Judge cannot assess` = sum(own$Judge %in% CANNOT),
    `Judge N/A` = sum(own$Judge %in% NOT_APPLICABLE),
    `Judge missing/failed` = sum(own$Status != "answered"), check.names = FALSE)
}))
table_out(summary, "judge-agreement")

readiness <- comparisons[comparisons$Item == "RD2", ]
false_ready <- readiness$Judge %in% c("4", "5") &
  (readiness$Human1 %in% c("1", "2", "3") | readiness$Human2 %in% c("1", "2", "3"))
emit(
  paste0("Exercises the Judge rated 4–5 where at least one planned human rating was 1–3: ",
    sum(false_ready), ". Inspect these cases and their evidence before interpreting agreement."),
  "",
  "The `judge-by-exercise.csv` file lists both judgments and the Judge for each item. Independently",
  "verified grading defects and unsupported citations require a separate evidence review.", ""
)
