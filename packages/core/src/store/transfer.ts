import * as z from "zod";

const preferenceStatusSchema = z.enum(["candidate", "active", "pinned", "suppressed", "superseded", "rejected"]);
const scopeTypeSchema = z.enum(["global", "repository", "path", "task", "agent"]);
const evidenceSourceTypeSchema = z.enum(["USER_EXPLICIT", "MODEL_EXTRACTED", "AGENT_EVENT", "IMPORT"]);
const evidencePolaritySchema = z.enum(["positive", "negative", "neutral"]);

const preferenceRecordSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    normalizedStatement: z.string().min(1),
    scopeType: scopeTypeSchema,
    scopeValue: z.string().nullable(),
    category: z.string().min(1),
    tags: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    status: preferenceStatusSchema,
    source: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    lastSeenAt: z.string().nullable(),
    supersedesId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

const evidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    preferenceId: z.string().min(1),
    sessionId: z.string().nullable(),
    agent: z.string().nullable(),
    sourceType: evidenceSourceTypeSchema,
    polarity: evidencePolaritySchema,
    weight: z.number().min(0),
    summary: z.string().min(1),
    evidenceHash: z.string().min(1),
    createdAt: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

const preferenceExportSchema = z
  .object({
    version: z.literal(1),
    exportedAt: z.string().min(1),
    preferences: z.array(
      z
        .object({
          preference: preferenceRecordSchema,
          evidence: z.array(evidenceRecordSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type PreferenceExport = z.infer<typeof preferenceExportSchema>;

export function parsePreferenceExport(input: string): PreferenceExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(`Invalid PrefKit JSON export: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = preferenceExportSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join(", ");
    throw new Error(`Invalid PrefKit JSON export: ${details}`);
  }

  const preferenceIds = new Set<string>();
  for (const item of result.data.preferences) {
    if (preferenceIds.has(item.preference.id)) {
      throw new Error(`Invalid PrefKit JSON export: duplicate preference id ${item.preference.id}`);
    }
    preferenceIds.add(item.preference.id);

    for (const evidence of item.evidence) {
      if (evidence.preferenceId !== item.preference.id) {
        throw new Error(`Invalid PrefKit JSON export: evidence ${evidence.id} points to the wrong preference`);
      }
    }
  }

  return result.data;
}
