import type { Phase } from "./exercise.ts";

/**
 * Checks on the assignment plan of the main raters. The plan is fixed before the study starts, so
 * each property the analysis relies on is verified here instead of being trusted:
 *
 * - every rater rates distinct exercises, one per course phase;
 * - every exercise is rated by the planned number of raters, each at a different position, so
 *   fatigue never affects all ratings of an exercise the same way;
 * - two raters share at most one exercise, and all raters are connected through shared exercises,
 *   which separates a rater's severity from an exercise's quality;
 * - each phase appears equally often at each position, give or take one.
 */

export interface PlanExercise {
  code: string;
  phase: Phase;
}

export interface PlanRater {
  id: string;
  exercises: string[];
}

export function planProblems(
  exercises: PlanExercise[],
  raters: PlanRater[],
  ratingsPerExercise: number,
): string[] {
  const problems: string[] = [];
  const phaseOf = new Map(exercises.map((exercise) => [exercise.code, exercise.phase]));
  const phases = [...new Set(exercises.map((exercise) => exercise.phase))].sort();

  for (const rater of raters) {
    const unknown = rater.exercises.filter((code) => !phaseOf.has(code));
    if (unknown.length > 0) {
      problems.push(`${rater.id} is assigned unknown exercises: ${unknown.join(", ")}`);
    }
    if (new Set(rater.exercises).size !== rater.exercises.length) {
      problems.push(`${rater.id} is assigned the same exercise twice`);
    }
    const raterPhases = rater.exercises.map((code) => phaseOf.get(code));
    if (new Set(raterPhases).size !== raterPhases.length) {
      problems.push(`${rater.id} rates more than one exercise of the same phase`);
    }
  }

  const ratersOf = new Map<string, Array<{ rater: string; position: number }>>();
  for (const rater of raters) {
    rater.exercises.forEach((code, index) => {
      ratersOf.set(code, [...(ratersOf.get(code) ?? []), { rater: rater.id, position: index + 1 }]);
    });
  }
  for (const exercise of exercises) {
    const ratings = ratersOf.get(exercise.code) ?? [];
    if (ratings.length !== ratingsPerExercise) {
      problems.push(
        `${exercise.code} is rated by ${ratings.length} raters, not ${ratingsPerExercise}`,
      );
    }
    const positions = ratings.map((rating) => rating.position);
    if (new Set(positions).size !== positions.length) {
      problems.push(`${exercise.code} is rated at the same position by two raters`);
    }
  }

  for (const [index, left] of raters.entries()) {
    for (const right of raters.slice(index + 1)) {
      const shared = left.exercises.filter((code) => right.exercises.includes(code));
      if (shared.length > 1) {
        problems.push(`${left.id} and ${right.id} share ${shared.length} exercises`);
      }
    }
  }

  if (raters.length > 1) {
    const reached = new Set([raters[0]?.id]);
    const queue = [raters[0]];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const other of raters) {
        if (
          !reached.has(other.id) &&
          other.exercises.some((code) => current?.exercises.includes(code))
        ) {
          reached.add(other.id);
          queue.push(other);
        }
      }
    }
    const isolated = raters.filter((rater) => !reached.has(rater.id)).map((rater) => rater.id);
    if (isolated.length > 0) {
      problems.push(`raters ${isolated.join(", ")} share no exercise with the others`);
    }
  }

  const longest = Math.max(0, ...raters.map((rater) => rater.exercises.length));
  for (let position = 0; position < longest; position += 1) {
    const counts = phases.map(
      (phase) =>
        raters.filter((rater) => {
          const code = rater.exercises[position];
          return code !== undefined && phaseOf.get(code) === phase;
        }).length,
    );
    if (Math.max(...counts) - Math.min(...counts) > 1) {
      problems.push(
        `position ${position + 1} is unbalanced across phases (${phases
          .map((phase, index) => `${phase} ${counts[index]}`)
          .join(", ")})`,
      );
    }
  }
  return problems;
}
