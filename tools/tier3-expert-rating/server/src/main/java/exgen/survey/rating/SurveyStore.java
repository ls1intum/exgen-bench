package exgen.survey.rating;

import exgen.survey.study.LoadedStudy;
import exgen.survey.study.Study.Role;
import exgen.survey.study.StudyLoader;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.InstantSource;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * Everything a study collects, in PostgreSQL. Answers are written once per step and never updated;
 * drafts are the only state that changes. Personal links are stored as SHA-256 digests, so the
 * database cannot reproduce a link that would let someone act as a rater.
 */
@Repository
public class SurveyStore {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final JsonMapper CANONICAL = JsonMapper.builder()
            .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .build();

    private final JdbcClient database;
    private final InstantSource clock;

    public SurveyStore(JdbcClient database, InstantSource clock) {
        this.database = database;
        this.clock = clock;
    }

    public record RaterRow(String id, Role role, LocalDate deadline, Instant declinedAt, Instant withdrawnAt) {}

    public record AssignmentRow(
            String raterId, int position, String exercise, String kind, String replaces, Instant createdAt) {}

    public record StepRow(
            String raterId,
            String step,
            Instant openedAt,
            String draft,
            Instant draftSavedAt,
            String answers,
            String instrumentVersion,
            Instant submittedAt) {}

    public record EventRow(String raterId, String step, String type, String target, Instant at) {}

    /** Who holds a link: the study team, or a rater. */
    public sealed interface Holder {
        record Admin() implements Holder {}

        record Rater(RaterRow rater) implements Holder {}
    }

    public static String linkDigest(String token) {
        return StudyLoader.sha256(("exgen-survey-link:" + token).getBytes(StandardCharsets.UTF_8));
    }

    /** The current time, to the millisecond, as every timestamp the study exports. */
    public Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MILLIS);
    }

    private static OffsetDateTime at(Instant instant) {
        return instant == null ? null : instant.atOffset(ZoneOffset.UTC);
    }

    private static Instant instant(ResultSet row, String column) throws SQLException {
        var value = row.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    private static RaterRow rater(ResultSet row, int index) throws SQLException {
        return new RaterRow(
                row.getString("id"),
                Role.of(row.getString("role")),
                row.getObject("deadline", LocalDate.class),
                instant(row, "declined_at"),
                instant(row, "withdrawn_at"));
    }

    private static AssignmentRow assignment(ResultSet row, int index) throws SQLException {
        return new AssignmentRow(
                row.getString("rater_id"),
                row.getInt("position"),
                row.getString("exercise"),
                row.getString("kind"),
                row.getString("replaces"),
                instant(row, "created_at"));
    }

    private static StepRow step(ResultSet row, int index) throws SQLException {
        return new StepRow(
                row.getString("rater_id"),
                row.getString("step"),
                instant(row, "opened_at"),
                row.getString("draft"),
                instant(row, "draft_saved_at"),
                row.getString("answers"),
                row.getString("instrument_version"),
                instant(row, "submitted_at"));
    }

    /**
     * Bring the database in line with the study: raters, their planned exercises, the instrument and
     * the digest of every built exercise are recorded once and are fixed from then on. A plan edited,
     * an exercise rebuilt or an instrument reworded after the study started is refused, so every
     * answer in the database refers to the same material and wording.
     */
    @Transactional
    public void synchronize(LoadedStudy loaded) {
        database.sql("SELECT pg_advisory_xact_lock(hashtext('exgen-survey'))")
                .query()
                .singleRow();
        var study = loaded.study();
        var studyId = freeze("study_id", study.id());
        if (!studyId.equals(study.id())) {
            throw new IllegalStateException("this database belongs to study " + studyId + ", not " + study.id());
        }
        var instrument = StudyLoader.sha256(CANONICAL.writeValueAsBytes(loaded.instrument()));
        if (!freeze("instrument", instrument).equals(instrument)) {
            throw new IllegalStateException(
                    "the instrument changed after this database was created; answers in it were given under the earlier wording");
        }
        for (var entry : loaded.manifest().exercises()) {
            if (!freeze("exercise:" + entry.code(), entry.sha256()).equals(entry.sha256())) {
                throw new IllegalStateException(entry.code()
                        + " was rebuilt after this database was created; answers in it refer to the earlier build");
            }
        }
        for (var rater : study.raters()) {
            var existing = rater(rater.id());
            if (existing.isEmpty()) {
                var deadline = study.deadlines().get(rater.role());
                database.sql("INSERT INTO rater (id, role, deadline) VALUES (?, ?, ?)")
                        .params(rater.id(), rater.role().id(), deadline == null ? null : LocalDate.parse(deadline))
                        .update();
            } else if (existing.get().role() != rater.role()) {
                throw new IllegalStateException(
                        rater.id() + " was a " + existing.get().role().id() + " rater and cannot become "
                                + rater.role().id());
            }
            var planned = database.sql(
                            "SELECT exercise FROM assignment WHERE rater_id = ? AND kind = 'planned' ORDER BY position")
                    .param(rater.id())
                    .query(String.class)
                    .list();
            if (planned.isEmpty()) {
                for (int index = 0; index < rater.exercises().size(); index++) {
                    database.sql(
                                    "INSERT INTO assignment (rater_id, position, exercise, kind, created_at) VALUES (?, ?, ?, 'planned', ?)")
                            .params(rater.id(), index + 1, rater.exercises().get(index), at(now()))
                            .update();
                }
            } else if (!planned.equals(rater.exercises())) {
                throw new IllegalStateException("the plan of " + rater.id() + " changed after the study started");
            }
        }
    }

    /** Record a value on first use; afterwards, return the value recorded then. */
    private String freeze(String key, String value) {
        database.sql("INSERT INTO frozen (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .params(key, value)
                .update();
        return database.sql("SELECT value FROM frozen WHERE key = ?")
                .param(key)
                .query(String.class)
                .single();
    }

    /** Issue a new personal link, revoking the holder's earlier links; {@code null} is the study team. */
    @Transactional
    public String issueLink(String raterId) {
        var bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        var token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        database.sql("UPDATE link SET revoked_at = ? WHERE rater_id IS NOT DISTINCT FROM ? AND revoked_at IS NULL")
                .params(at(now()), raterId)
                .update();
        database.sql("INSERT INTO link (hash, rater_id, created_at) VALUES (?, ?, ?)")
                .params(linkDigest(token), raterId, at(now()))
                .update();
        return token;
    }

    public Optional<Holder> holderOf(String token) {
        var link = database.sql("SELECT rater_id FROM link WHERE hash = ? AND revoked_at IS NULL")
                .param(linkDigest(token))
                .query((row, index) -> Optional.ofNullable(row.getString("rater_id")))
                .optional();
        if (link.isEmpty()) {
            return Optional.empty();
        }
        return link.get().isEmpty()
                ? Optional.of(new Holder.Admin())
                : rater(link.get().get()).map(Holder.Rater::new);
    }

    public Optional<RaterRow> rater(String id) {
        return database.sql("SELECT * FROM rater WHERE id = ?")
                .param(id)
                .query(SurveyStore::rater)
                .optional();
    }

    public List<RaterRow> raters() {
        return database.sql("SELECT * FROM rater ORDER BY ordinal")
                .query(SurveyStore::rater)
                .list();
    }

    /** Serialize a rater's requests, so two tabs cannot both submit the same step. */
    public void lock(String raterId) {
        database.sql("SELECT id FROM rater WHERE id = ? FOR UPDATE")
                .param(raterId)
                .query(String.class)
                .optional();
    }

    public List<AssignmentRow> assignments() {
        return database.sql("SELECT * FROM assignment ORDER BY rater_id, position")
                .query(SurveyStore::assignment)
                .list();
    }

    public List<AssignmentRow> assignments(String raterId) {
        return database.sql("SELECT * FROM assignment WHERE rater_id = ? ORDER BY position")
                .param(raterId)
                .query(SurveyStore::assignment)
                .list();
    }

    public List<StepRow> steps() {
        return database.sql("SELECT * FROM step ORDER BY rater_id")
                .query(SurveyStore::step)
                .list();
    }

    public List<StepRow> steps(String raterId) {
        return database.sql("SELECT * FROM step WHERE rater_id = ? ORDER BY submitted_at, step")
                .param(raterId)
                .query(SurveyStore::step)
                .list();
    }

    public Optional<StepRow> step(String raterId, String key) {
        return database.sql("SELECT * FROM step WHERE rater_id = ? AND step = ?")
                .params(raterId, key)
                .query(SurveyStore::step)
                .optional();
    }

    public List<EventRow> events() {
        return database.sql("SELECT rater_id, step, type, target, at FROM event ORDER BY id")
                .query((row, index) -> new EventRow(
                        row.getString("rater_id"),
                        row.getString("step"),
                        row.getString("type"),
                        row.getString("target"),
                        instant(row, "at")))
                .list();
    }

    /** The step a rater is on, derived from what is stored. */
    public Step current(RaterRow rater) {
        var submitted =
                new HashSet<>(database.sql("SELECT step FROM step WHERE rater_id = ? AND submitted_at IS NOT NULL")
                        .param(rater.id())
                        .query(String.class)
                        .list());
        var positions =
                assignments(rater.id()).stream().map(AssignmentRow::position).toList();
        return Step.current(rater.declinedAt() != null, submitted, positions);
    }

    /** Record when a step's material was first shown; later calls keep the first time. */
    public void open(String raterId, String key) {
        database.sql("""
                        INSERT INTO step (rater_id, step, opened_at) VALUES (?, ?, ?)
                        ON CONFLICT (rater_id, step) DO UPDATE SET opened_at = coalesce(step.opened_at, excluded.opened_at)""").params(raterId, key, at(now())).update();
    }

    public Instant saveDraft(String raterId, String key, String draft) {
        var savedAt = now();
        database.sql("""
                        INSERT INTO step (rater_id, step, draft, draft_saved_at) VALUES (?, ?, CAST(? AS json), ?)
                        ON CONFLICT (rater_id, step) DO UPDATE SET draft = excluded.draft, draft_saved_at = excluded.draft_saved_at
                        WHERE step.submitted_at IS NULL""").params(raterId, key, draft, at(savedAt)).update();
        return savedAt;
    }

    /** Store a step's final answers. A step is submitted exactly once, and only as the current step. */
    @Transactional
    public void submit(RaterRow rater, Step step, String answers, String instrumentVersion) {
        lock(rater.id());
        var expected = current(rater).key();
        if (!expected.equals(step.key())) {
            throw new StepConflict("expected step " + expected + ", not " + step.key());
        }
        var now = at(now());
        database.sql("""
                        INSERT INTO step (rater_id, step, opened_at, answers, instrument_version, submitted_at)
                        VALUES (?, ?, ?, CAST(? AS json), ?, ?)
                        ON CONFLICT (rater_id, step) DO UPDATE SET answers = excluded.answers,
                          instrument_version = excluded.instrument_version, submitted_at = excluded.submitted_at,
                          opened_at = coalesce(step.opened_at, excluded.opened_at), draft = NULL""")
                .params(rater.id(), step.key(), now, answers, instrumentVersion, now)
                .update();
    }

    public void decline(String raterId) {
        database.sql("UPDATE rater SET declined_at = ? WHERE id = ? AND declined_at IS NULL")
                .params(at(now()), raterId)
                .update();
    }

    @Transactional
    public void logEvents(String raterId, String key, List<ViewEvent> events) {
        var now = at(now());
        for (var event : events) {
            database.sql("INSERT INTO event (rater_id, step, type, target, at) VALUES (?, ?, ?, ?, ?)")
                    .params(raterId, key, event.type(), event.target(), now)
                    .update();
        }
    }

    /** A material view or file a rater opened. */
    public record ViewEvent(String type, String target) {}

    /**
     * Delete everything a rater answered, at their request, and revoke their links. The rater stays
     * in the plan with the time they withdrew, so the study team can assign a backup.
     */
    @Transactional
    public void withdraw(String raterId) {
        var now = at(now());
        database.sql("DELETE FROM step WHERE rater_id = ?").param(raterId).update();
        database.sql("DELETE FROM event WHERE rater_id = ?").param(raterId).update();
        database.sql("UPDATE link SET revoked_at = ? WHERE rater_id = ? AND revoked_at IS NULL")
                .params(now, raterId)
                .update();
        database.sql("UPDATE rater SET withdrawn_at = coalesce(withdrawn_at, ?) WHERE id = ?")
                .params(now, raterId)
                .update();
    }

    public void setDeadline(String raterId, LocalDate deadline) {
        database.sql("UPDATE rater SET deadline = ? WHERE id = ?")
                .params(deadline, raterId)
                .update();
    }

    /** Assign exercises to a reserve rater after their earlier assignments. */
    @Transactional
    public void assign(String raterId, List<String> exercises, String kind, String replaces) {
        lock(raterId);
        int position = assignments(raterId).stream()
                .mapToInt(AssignmentRow::position)
                .max()
                .orElse(0);
        for (var exercise : exercises) {
            position++;
            database.sql(
                            "INSERT INTO assignment (rater_id, position, exercise, kind, replaces, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                    .params(raterId, position, exercise, kind, replaces, at(now()))
                    .update();
        }
    }
}
