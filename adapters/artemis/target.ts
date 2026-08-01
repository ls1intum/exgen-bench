import { z } from "zod";

const PROGRAMMING_LANGUAGES = [
  "ADA",
  "ASSEMBLER",
  "BASH",
  "C",
  "C_PLUS_PLUS",
  "C_SHARP",
  "DART",
  "EMPTY",
  "GO",
  "HASKELL",
  "JAVA",
  "JAVASCRIPT",
  "KOTLIN",
  "MATLAB",
  "OCAML",
  "PHP",
  "POWERSHELL",
  "PYTHON",
  "R",
  "RUBY",
  "RUST",
  "SQL",
  "SWIFT",
  "TYPESCRIPT",
  "VHDL",
] as const;

const PROJECT_TYPES = [
  "FACT",
  "GCC",
  "GRADLE_GRADLE",
  "MAVEN_BLACKBOX",
  "MAVEN_MAVEN",
  "PLAIN",
  "PLAIN_GRADLE",
  "PLAIN_MAVEN",
  "XCODE",
] as const;

type ProgrammingLanguage = (typeof PROGRAMMING_LANGUAGES)[number];
type ProjectType = (typeof PROJECT_TYPES)[number];

/**
 * Artemis rejects an exercise whose project type disagrees with its language: a null project type
 * for a language that declares any (`projectTypeNotSet`), and a non-null one for a language that
 * declares none (`projectTypeSet`). Only these three languages declare any, and the LocalCI and
 * Jenkins feature services agree on all three. A deployment licence filter can narrow a list
 * further at runtime, so this rejects early rather than admitting authoritatively.
 */
const PROJECT_TYPES_BY_LANGUAGE: Partial<Record<ProgrammingLanguage, readonly ProjectType[]>> = {
  C: ["FACT", "GCC"],
  JAVA: ["PLAIN_GRADLE", "GRADLE_GRADLE", "PLAIN_MAVEN", "MAVEN_MAVEN", "MAVEN_BLACKBOX"],
  SWIFT: ["PLAIN"],
};

/** Artemis rejects a missing package name for exactly these languages, on both CI backends. */
const PACKAGE_NAME_REQUIRED: readonly ProgrammingLanguage[] = [
  "JAVA",
  "KOTLIN",
  "SWIFT",
  "GO",
  "DART",
];

const DAY_MS = 86_400_000;

function buildSystemOf(projectType: ProjectType | null): string {
  if (projectType === null) return "none";
  // Mirrors ProjectType.isMaven and ProjectType.isGradle.
  if (["MAVEN_MAVEN", "PLAIN_MAVEN", "MAVEN_BLACKBOX"].includes(projectType)) return "maven";
  if (["PLAIN_GRADLE", "GRADLE_GRADLE"].includes(projectType)) return "gradle";
  return projectType.toLowerCase();
}

export const artemisTargetParametersSchema = z
  .strictObject({
    // The harness spells this as a lowercase identifier; Artemis spells it as an enum constant.
    language: z
      .string()
      .default("JAVA")
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(PROGRAMMING_LANGUAGES)),
    project_type: z.enum(PROJECT_TYPES).nullable().default("PLAIN_MAVEN"),
    // Descriptive, never derived from: `maven` names two Artemis project types that build the
    // assignment differently, so resolving it would pick a treatment by guess. Checked against
    // project_type instead, the same way the target identifier is.
    build_system: z.string().min(1).optional(),
    package_prefix: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)
      .max(24)
      .optional(),
    // Adds a static-analysis clause to the Hyperion system prompt, adds a report-collection stanza
    // to the generated verify.sh, and adds a gate that rejects a reference solution producing
    // penalised findings. It is a treatment, not a formatting detail.
    static_code_analysis: z.boolean().default(false),
    sequential_test_runs: z.boolean().default(false),
    // A null due date forbids the agent from authoring AFTER_DUE_DATE tests: the prompt says every
    // hidden-variant cell must be `no`, and three later gates reject a plan that hides anything.
    // Setting a due date is what enables hidden-test authoring.
    hidden_tests: z.boolean().default(true),
    max_points: z.number().positive().max(10_000).default(100),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
    // Artemis treats a null release date as already released, and Hyperion refuses to generate into
    // a released exercise.
    release_lead_ms: z
      .number()
      .int()
      .positive()
      .max(365 * DAY_MS)
      .default(2 * DAY_MS),
  })
  .superRefine((value, context) => {
    if (value.static_code_analysis && value.sequential_test_runs) {
      context.addIssue({
        code: "custom",
        path: ["static_code_analysis"],
        message: "Artemis rejects static code analysis combined with sequential test runs",
      });
    }
    if (value.static_code_analysis && value.project_type === "FACT") {
      context.addIssue({
        code: "custom",
        path: ["static_code_analysis"],
        message: "Artemis rejects static code analysis for FACT project types",
      });
    }
    const projectTypes = PROJECT_TYPES_BY_LANGUAGE[value.language];
    if (!projectTypes && value.project_type !== null) {
      context.addIssue({
        code: "custom",
        path: ["project_type"],
        message: `Artemis rejects a project type for ${value.language}; use null`,
      });
    }
    if (
      projectTypes &&
      (value.project_type === null || !projectTypes.includes(value.project_type))
    ) {
      context.addIssue({
        code: "custom",
        path: ["project_type"],
        message: `${value.language} requires one of ${projectTypes.join(", ")}`,
      });
    }
    if (value.package_prefix !== undefined && !PACKAGE_NAME_REQUIRED.includes(value.language)) {
      context.addIssue({
        code: "custom",
        path: ["package_prefix"],
        message: `Artemis rejects a package name for ${value.language}; omit package_prefix`,
      });
    }
    const expected = buildSystemOf(value.project_type);
    if (value.build_system !== undefined && value.build_system !== expected) {
      context.addIssue({
        code: "custom",
        path: ["build_system"],
        message: `project_type ${value.project_type} builds with ${expected}, not ${value.build_system}`,
      });
    }
  });

export type ArtemisTargetParameters = z.infer<typeof artemisTargetParametersSchema>;

/**
 * Target identifiers that name a format in the identifier itself. The identifier and
 * `target.parameters` then state the same thing twice, so they are checked against each other; a
 * new arm should prefer the format-agnostic identifier and let the parameters carry the format.
 */
const TARGET_FORMAT_CONSTRAINTS: Record<
  string,
  { language: ProgrammingLanguage; projectTypes: readonly ProjectType[] }
> = {
  "artemis-java-maven": {
    language: "JAVA",
    projectTypes: ["PLAIN_MAVEN", "MAVEN_MAVEN", "MAVEN_BLACKBOX"],
  },
};

export function resolveTargetFormat(
  targetId: string,
  parameters: unknown,
): ArtemisTargetParameters {
  const format = artemisTargetParametersSchema.parse(parameters);
  const constraint = TARGET_FORMAT_CONSTRAINTS[targetId];
  if (!constraint) return format;
  if (
    format.language !== constraint.language ||
    format.project_type === null ||
    !constraint.projectTypes.includes(format.project_type)
  ) {
    throw new Error(
      `target ${targetId} names ${constraint.language}/${constraint.projectTypes.join("|")} but target.parameters select ${format.language}/${format.project_type}`,
    );
  }
  return format;
}

export function requiresPackageName(format: ArtemisTargetParameters): boolean {
  return PACKAGE_NAME_REQUIRED.includes(format.language);
}
