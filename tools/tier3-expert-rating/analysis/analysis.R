#!/usr/bin/env Rscript
# The analysis plan of the expert study (study design, Section 8), applied to the data.json of an
# `exgen survey export`. Usage: Rscript analysis.R <data.json> <output directory>
#
# It writes REPORT.md and one CSV per table into tables/. The output depends only on the input, the
# seed, and the package versions the container pins, so a report can be regenerated and compared.

suppressPackageStartupMessages({
  library(jsonlite)
  library(irrCAC)
  library(ordinal)
})

arguments <- commandArgs(trailingOnly = TRUE)
if (length(arguments) != 2) stop("usage: Rscript analysis.R <data.json> <output directory>")
input <- arguments[1]
output <- arguments[2]
seed <- as.integer(Sys.getenv("SURVEY_ANALYSIS_SEED", "20261026"))
input_sha256 <- Sys.getenv("SURVEY_ANALYSIS_INPUT_SHA256", "not given")
resamples <- 2000L
dir.create(file.path(output, "tables"), recursive = TRUE, showWarnings = FALSE)

data <- fromJSON(input, simplifyVector = FALSE)
instrument <- data$instrument
study <- data$study

# ---- Data -------------------------------------------------------------------------------------

as_frame <- function(rows) {
  columns <- unique(unlist(lapply(rows, names)))
  frame <- lapply(columns, function(column) {
    values <- lapply(rows, function(row) if (is.null(row[[column]])) NA else row[[column]])
    unlist(values)
  })
  names(frame) <- columns
  as.data.frame(frame, stringsAsFactors = FALSE)
}
column <- function(frame, name) if (name %in% names(frame)) frame[[name]] else rep(NA, nrow(frame))

ratings <- as_frame(data$tables$ratings)
complete <- !is.na(column(ratings, "complete")) & column(ratings, "complete")
# The planned ratings: a main rater's, or a reserve rater's backup for one. Tie-breaker ratings
# only classify exercises (Section 8.1).
planned <- ratings[complete & ((ratings$assignment == "planned" & ratings$role == "main") |
  ratings$assignment == "backup"), , drop = FALSE]
tie <- ratings[complete & ratings$assignment == "tie_breaker", , drop = FALSE]
planned$position <- as.integer(planned$position)
planned$RD1 <- as.integer(planned$RD1)
planned$RD2 <- as.integer(planned$RD2)
tie$RD2 <- as.integer(column(tie, "RD2"))

items <- do.call(c, lapply(instrument$questionnaire$parts, function(part) {
  lapply(part$items, function(item) c(item, part = part$id))
}))
option_values <- function(item) vapply(item$options, function(option) as.character(option$value), "")
yes_items <- Filter(function(item) {
  item$kind == "choice" && item$part != "D" && "yes" %in% option_values(item)
}, items)
dimension_of <- function(item) if (is.null(item$dimension)) item$id else item$dimension

exercises <- vapply(study$exercises, function(entry) entry$code, "")
phases <- setNames(vapply(study$exercises, function(entry) entry$phase, ""), exercises)
expected <- length(exercises) * study$ratings_per_exercise

# ---- Helpers ----------------------------------------------------------------------------------

report <- character()
emit <- function(...) report <<- c(report, ...)
table_out <- function(frame, name) {
  write.csv(frame, file.path(output, "tables", paste0(name, ".csv")), row.names = FALSE, na = "")
  text <- as.data.frame(lapply(frame, function(values) ifelse(is.na(values), "—", as.character(values))))
  emit(
    paste0("| ", paste(names(frame), collapse = " | "), " |"),
    paste0("|", strrep(" --- |", ncol(frame))),
    apply(text, 1, function(row) paste0("| ", paste(row, collapse = " | "), " |")),
    ""
  )
}
share <- function(x) if (is.na(x)) NA else sprintf("%.0f %%", 100 * x)
interval <- function(bounds) {
  if (any(is.na(bounds))) NA else sprintf("%.0f–%.0f %%", 100 * bounds[1], 100 * bounds[2])
}
fixed <- function(x, digits = 2) if (is.na(x)) NA else formatC(x, format = "f", digits = digits)
# irrCAC reports an interval as "(lower,upper)".
coefficient_interval <- function(text) {
  bounds <- as.numeric(regmatches(text, gregexpr("-?[0-9.]+", text))[[1]])
  if (length(bounds) != 2) NA else paste(fixed(bounds[1]), "to", fixed(bounds[2]))
}
readiness_class <- function(level) {
  factor(ifelse(level >= 4, "ready", ifelse(level == 3, "usable", "not usable")),
    levels = c("ready", "usable", "not usable"))
}

# A 95 % percentile interval from resampling exercises, the unit both ratings of an exercise share.
# The seed is reset for every statistic, so each interval is reproducible on its own.
cluster_interval <- function(frame, statistic) {
  if (nrow(frame) == 0) return(c(NA, NA))
  groups <- split(frame, frame$exercise_code)
  set.seed(seed)
  values <- replicate(resamples, {
    drawn <- sample(names(groups), length(groups), replace = TRUE)
    statistic(do.call(rbind, groups[drawn]))
  })
  quantile(values, c(0.025, 0.975), names = FALSE, na.rm = TRUE)
}

pairs_of <- function(frame) {
  by_exercise <- split(frame, frame$exercise_code)
  Filter(function(rows) nrow(rows) == 2, by_exercise)
}

# ---- Report -----------------------------------------------------------------------------------

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
    "- Planned ratings: ", nrow(planned), " complete of ", expected, " planned (",
    length(exercises), " exercises × ", study$ratings_per_exercise, "), ",
    sum(planned$assignment == "backup"), " of them by backup raters."
  ),
  paste0("- Tie-breaker ratings: ", nrow(tie), "; they only classify exercises (Section 8.1)."),
  paste0(
    "- Intervals: 95 % percentile intervals from ", resamples,
    " bootstrap resamples of exercises, seed ", seed, "."
  ),
  paste0(
    "- ", R.version.string, ", irrCAC ", packageVersion("irrCAC"), ", ordinal ",
    packageVersion("ordinal"), "."
  ),
  "",
  "All inferential results are exploratory, as the study design states (Section 8).",
  ""
)

# 8.1 Readiness --------------------------------------------------------------------------------

emit("## Readiness (Section 8.1)", "", "Share of planned ratings per readiness class.", "")
classes <- do.call(rbind, lapply(c("RD1", "RD2"), function(item) {
  do.call(rbind, lapply(levels(readiness_class(1)), function(level) {
    statistic <- function(frame) mean(readiness_class(frame[[item]]) == level)
    data.frame(
      Item = item, Class = level, Ratings = sum(readiness_class(planned[[item]]) == level),
      Share = share(statistic(planned)), CI = interval(cluster_interval(planned, statistic)),
      check.names = FALSE
    )
  }))
}))
table_out(classes, "readiness-classes")

emit(
  "Exercises by the class of their RD2 ratings: the shared class of both planned ratings; with a",
  "tie breaker, the class of the median of three; otherwise the class of the lower rating. The mean",
  "of the planned ratings is the sensitivity check.",
  ""
)
by_exercise <- do.call(rbind, lapply(exercises, function(code) {
  values <- planned$RD2[planned$exercise_code == code]
  third <- tie$RD2[tie$exercise_code == code]
  classes <- unique(as.character(readiness_class(values)))
  rule <- if (length(values) == 0) "no rating" else if (length(classes) == 1 && length(values) >= 2) {
    "agree"
  } else if (length(third) > 0) "median of three" else if (length(values) >= 2) {
    "lower rating"
  } else "one rating"
  level <- switch(rule,
    "no rating" = NA,
    "agree" = values[1],
    "median of three" = median(c(values, third[1])),
    "lower rating" = min(values),
    "one rating" = values[1]
  )
  data.frame(
    Exercise = code, Phase = phases[[code]], RD2 = paste(values, collapse = ", "),
    `Tie breaker` = if (length(third) > 0) as.character(third[1]) else NA,
    Rule = rule, Class = if (is.na(level)) NA else as.character(readiness_class(level)),
    `Planned mean` = if (length(values) == 0) NA else fixed(mean(values), 1),
    check.names = FALSE
  )
}))
table_out(by_exercise, "readiness-exercises")
summary_classes <- as.data.frame(table(factor(by_exercise$Class, levels = levels(readiness_class(1)))))
names(summary_classes) <- c("Class", "Exercises")
table_out(summary_classes, "readiness-exercise-classes")

# 8.2 SQ1 ---------------------------------------------------------------------------------------

emit(
  "## SQ1: Didactical quality (Section 8.2)", "",
  "Share of Yes per item among the planned ratings. N/A is reported apart.", ""
)
item_rows <- do.call(rbind, lapply(yes_items, function(item) {
  answers <- planned[[item$id]]
  statistic <- function(frame) mean(frame[[item$id]] == "yes", na.rm = TRUE)
  data.frame(
    Dimension = dimension_of(item), Item = item$id, Ratings = sum(!is.na(answers)),
    Yes = sum(answers == "yes", na.rm = TRUE), `N/A` = sum(answers == "na", na.rm = TRUE),
    `Share of Yes` = share(statistic(planned)), CI = interval(cluster_interval(planned, statistic)),
    check.names = FALSE
  )
}))
table_out(item_rows, "sq1-items")

emit("A dimension is met when all its items are answered Yes, where N/A counts as Yes.", "")
dimensions <- unique(vapply(yes_items, dimension_of, ""))
dimension_rows <- do.call(rbind, lapply(dimensions, function(dimension) {
  ids <- vapply(Filter(function(item) dimension_of(item) == dimension, yes_items), function(item) item$id, "")
  met <- function(frame) {
    rowSums(sapply(ids, function(id) !(frame[[id]] %in% c("yes", "na"))), na.rm = TRUE) == 0
  }
  statistic <- function(frame) mean(met(frame))
  data.frame(
    Dimension = dimension, Items = paste(ids, collapse = ", "), Met = sum(met(planned)),
    Share = share(statistic(planned)), CI = interval(cluster_interval(planned, statistic)),
    check.names = FALSE
  )
}))
table_out(dimension_rows, "sq1-dimensions")

emit("Distribution of the readiness levels, overall and per course phase.", "")
distribution <- do.call(rbind, lapply(c("RD1", "RD2"), function(item) {
  do.call(rbind, lapply(c("all", "early", "middle", "late"), function(phase) {
    values <- if (phase == "all") planned[[item]] else planned[[item]][planned$phase == phase]
    counts <- as.integer(table(factor(values, levels = 1:5)))
    row <- data.frame(Item = item, Phase = phase, Ratings = length(values), check.names = FALSE)
    for (level in 1:5) row[[as.character(level)]] <- counts[level]
    row$Median <- if (length(values) == 0) NA else fixed(median(values), 1)
    row
  }))
}))
table_out(distribution, "sq1-readiness-distribution")

emit(
  "Cumulative link mixed model `RD ~ course phase + position + (1 | rater) + (1 | exercise)`,",
  "logit link, early phase as reference. Positive estimates mean higher readiness.",
  ""
)
for (item in c("RD1", "RD2")) {
  frame <- data.frame(
    rd = factor(planned[[item]], levels = 1:5, ordered = TRUE),
    phase = factor(planned$phase, levels = c("early", "middle", "late")),
    position = planned$position, rater = factor(planned$rater_id),
    exercise = factor(planned$exercise_code)
  )
  fit <- tryCatch(
    clmm(rd ~ phase + position + (1 | rater) + (1 | exercise), data = droplevels(frame), nAGQ = 1),
    error = function(error) error
  )
  if (inherits(fit, "error")) {
    emit(paste0(
      "**", item, ":** the model did not converge (", conditionMessage(fit), "). As the study ",
      "design plans for this case, only the descriptive results above are reported."
    ), "")
    next
  }
  coefficients <- summary(fit)$coefficients
  terms <- c(grep("^phase", rownames(coefficients), value = TRUE), "position")
  terms <- intersect(terms, rownames(coefficients))
  rows <- data.frame(
    Term = terms,
    Estimate = vapply(terms, function(term) fixed(coefficients[term, 1]), ""),
    SE = vapply(terms, function(term) fixed(coefficients[term, 2]), ""),
    z = vapply(terms, function(term) fixed(coefficients[term, 3]), ""),
    p = vapply(terms, function(term) fixed(coefficients[term, 4], 3), ""),
    check.names = FALSE
  )
  converged <- fit$optRes$convergence == 0 && max(abs(fit$gradient)) < 1e-3
  deviations <- vapply(VarCorr(fit), function(variance) sqrt(as.numeric(variance)), 0)
  emit(paste0(
    "**", item, ":** ", if (converged) "converged" else "did not converge; read the estimates with care",
    ". Standard deviation of the rater effect ", fixed(deviations[["rater"]]),
    ", of the exercise effect ", fixed(deviations[["exercise"]]), "."
  ), "")
  table_out(rows, paste0("sq1-clmm-", tolower(item)))
}

texts <- c(grep("_text$", names(planned), value = TRUE), "CHG")
coded <- sum(vapply(intersect(texts, names(planned)), function(name) {
  sum(!is.na(planned[[name]]) & nzchar(planned[[name]]))
}, 0))
emit(paste0(
  "Free texts for the thematic analysis: ", coded, " answers to \"where\" and the most important ",
  "change. Two researchers code them outside this report."
), "")

# 8.3 SQ2 ---------------------------------------------------------------------------------------

emit("## SQ2: Rater agreement (Section 8.3)", "")
pairs <- pairs_of(planned)
emit(paste0("Exercises with two planned ratings: ", length(pairs), " of ", length(exercises), "."), "")
pair_frame <- function(id) {
  data.frame(
    first = vapply(pairs, function(rows) as.character(rows[[id]][1]), ""),
    second = vapply(pairs, function(rows) as.character(rows[[id]][2]), ""),
    stringsAsFactors = FALSE
  )
}
ac1 <- function(frame) {
  if (nrow(frame) == 0) return(list(value = NA, interval = NA))
  estimate <- tryCatch(gwet.ac1.raw(frame)$est, error = function(error) NULL)
  if (is.null(estimate)) return(list(value = NA, interval = NA))
  list(value = fixed(estimate$coeff.val), interval = coefficient_interval(estimate$conf.int))
}
agreement_rows <- do.call(rbind, lapply(yes_items, function(item) {
  frame <- pair_frame(item$id)
  coefficient <- ac1(frame)
  data.frame(
    Item = item$id, Pairs = nrow(frame),
    Agreement = if (nrow(frame) == 0) NA else share(mean(frame$first == frame$second)),
    AC1 = coefficient$value, CI = coefficient$interval, check.names = FALSE
  )
}))
table_out(agreement_rows, "sq2-items")

pooled <- do.call(rbind, lapply(yes_items, function(item) pair_frame(item$id)))
coefficient <- ac1(pooled)
emit(paste0(
  "Pooled across the items: agreement ", share(mean(pooled$first == pooled$second)),
  ", AC1 ", coefficient$value, " (CI ", coefficient$interval, "; ", nrow(pooled),
  " exercise–item pairs)."
), "")

readiness_rows <- do.call(rbind, lapply(c("RD1", "RD2"), function(item) {
  frame <- data.frame(
    first = vapply(pairs, function(rows) rows[[item]][1], 0L),
    second = vapply(pairs, function(rows) rows[[item]][2], 0L)
  )
  alpha <- tryCatch(
    krippen.alpha.raw(frame, weights = "ordinal", categ.labels = 1:5)$est,
    error = function(error) NULL
  )
  data.frame(
    Item = item, Pairs = nrow(frame),
    `Within one level` = share(mean(abs(frame$first - frame$second) <= 1)),
    `Krippendorff's alpha (ordinal)` = if (is.null(alpha)) NA else fixed(alpha$coeff.val),
    CI = if (is.null(alpha)) NA else coefficient_interval(alpha$conf.int),
    check.names = FALSE
  )
}))
table_out(readiness_rows, "sq2-readiness")

# 8.4 SQ3 ---------------------------------------------------------------------------------------

emit("## SQ3: Influence and correctness of the automatic findings (Section 8.4)", "")
difference <- planned$RD2 - planned$RD1
changes <- as.data.frame(table(factor(difference, levels = -4:4)))
names(changes) <- c("RD2 − RD1", "Ratings")
table_out(changes[changes$Ratings > 0, , drop = FALSE], "sq3-readiness-change")
test <- tryCatch(
  suppressWarnings(wilcox.test(planned$RD2, planned$RD1, paired = TRUE, exact = FALSE)),
  error = function(error) NULL
)
emit(paste0(
  "Changed decisions: ", sum(difference != 0), " of ", length(difference), " (",
  share(mean(difference != 0)), "); ", sum(difference < 0), " lower, ", sum(difference > 0),
  " higher. Wilcoxon signed-rank test (exploratory): ",
  if (is.null(test) || is.na(test$p.value)) "not defined, as no rating changed" else {
    paste0("V = ", test$statistic, ", p = ", fixed(test$p.value, 3))
  }, "."
), "")

findings <- do.call(rbind, lapply(c("AF1", "AF2"), function(id) {
  answers <- planned[[id]]
  data.frame(
    Item = id, Yes = sum(answers == "yes", na.rm = TRUE), No = sum(answers == "no", na.rm = TRUE),
    `N/A` = sum(answers == "na", na.rm = TRUE), check.names = FALSE
  )
}))
table_out(findings, "sq3-findings")
emit(
  "AF1 Yes: the findings revealed a material problem the rater had missed. AF2 No: at least one",
  "finding was wrong or irrelevant; grouping these by type of finding needs the coded AF2 texts.",
  ""
)

# 8.5 SQ4 and timing ----------------------------------------------------------------------------

emit(
  "## SQ4: Automatic evaluation and instructors (Section 8.5)", "",
  "Not part of this report: it needs the LLM judge's verdicts on the same items and the automatic",
  "metrics per exercise, joined by exercise code.", "",
  "## Time per exercise", "",
  "Median minutes from opening a part's material to submitting it, over the planned ratings; the",
  "pilot's criterion is a median of at most 20 minutes per exercise.", ""
)
seconds <- sapply(c("A", "B", "C", "D"), function(part) as.numeric(column(planned, paste0("seconds_", part))))
if (is.null(dim(seconds))) seconds <- matrix(seconds, nrow = nrow(planned))
timing <- data.frame(
  Part = c("A", "B", "C", "D", "Exercise"),
  Minutes = c(
    vapply(1:4, function(index) fixed(median(seconds[, index], na.rm = TRUE) / 60, 1), ""),
    fixed(median(rowSums(seconds), na.rm = TRUE) / 60, 1)
  ),
  check.names = FALSE
)
table_out(timing, "time")

writeLines(report, file.path(output, "REPORT.md"))
