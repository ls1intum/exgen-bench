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

/** Project types accepted by both Artemis CI backends before deployment-specific filtering. */
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
  if (["MAVEN_MAVEN", "PLAIN_MAVEN", "MAVEN_BLACKBOX"].includes(projectType)) return "maven";
  if (["PLAIN_GRADLE", "GRADLE_GRADLE"].includes(projectType)) return "gradle";
  return projectType.toLowerCase();
}

export const artemisTargetParametersSchema = z
  .strictObject({
    language: z
      .string()
      .default("JAVA")
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(PROGRAMMING_LANGUAGES)),
    project_type: z.enum(PROJECT_TYPES).nullable().default("PLAIN_MAVEN"),
    // Descriptive only: one build system can map to distinct project-type treatments.
    build_system: z.string().min(1).optional(),
    package_prefix: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)
      .max(24)
      .optional(),
    // Static analysis changes prompts, verification, and acceptance gates.
    static_code_analysis: z.boolean().default(false),
    sequential_test_runs: z.boolean().default(false),
    // Hidden tests require a due date in Artemis.
    hidden_tests: z.boolean().default(true),
    max_points: z.number().positive().max(10_000).default(100),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).default("MEDIUM"),
    // Hyperion refuses to generate into an exercise Artemis considers released.
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

/** Constraints for legacy target IDs that duplicate format information from target parameters. */
const TARGET_FORMAT_CONSTRAINTS: Record<
  string,
  { language: ProgrammingLanguage; projectTypes: readonly ProjectType[] }
> = {
  "artemis-java-maven": {
    language: "JAVA",
    projectTypes: ["PLAIN_MAVEN", "MAVEN_MAVEN", "MAVEN_BLACKBOX"],
  },
  "artemis-java-gradle": {
    language: "JAVA",
    projectTypes: ["PLAIN_GRADLE", "GRADLE_GRADLE"],
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
