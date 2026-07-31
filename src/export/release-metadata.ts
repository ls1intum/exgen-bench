import { z } from "zod";

const creatorSchema = z
  .object({
    name: z.string().min(1),
    orcid: z.string().regex(/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/),
  })
  .strict();

const designationSchema = z
  .object({
    status: z.enum(["exploratory", "submitted"]),
  })
  .strict();

export const releaseMetadataFileSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    url: z.string().url(),
    creators: z.array(creatorSchema).min(1),
    created_at: z.string().datetime({ offset: true }),
    designation: designationSchema,
  })
  .strict()
  .superRefine((release, context) => {
    const orcids = release.creators.map((creator) => creator.orcid);
    if (new Set(orcids).size !== orcids.length) {
      context.addIssue({
        code: "custom",
        path: ["creators"],
        message: "creator ORCIDs must be unique",
      });
    }
  });

export type ReleaseMetadataFile = z.infer<typeof releaseMetadataFileSchema>;
