import * as z from "zod";
import type { StoreContext } from "./context.js";
import {
  allPreferences,
  evidenceFor,
  insertEvidence,
  insertPreference,
  preferenceExists,
} from "./preferences.js";
import { rowToPreference, samePreference, type Row } from "./rows.js";
import type { ImportReport } from "./types.js";

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

export function exportMarkdown(ctx: StoreContext): string {
  const preferences = allPreferences(ctx);
  const lines = ["# PrefKit Preferences", "", `Exported: ${new Date().toISOString()}`, ""];

  for (const pref of preferences) {
    lines.push(`## ${pref.statement}`);
    lines.push("");
    lines.push(`- id: ${pref.id}`);
    lines.push(`- status: ${pref.status}`);
    lines.push(`- confidence: ${pref.confidence.toFixed(2)}`);
    lines.push(`- scope: ${pref.scopeType}${pref.scopeValue === null ? "" : `:${pref.scopeValue}`}`);
    lines.push(`- category: ${pref.category}`);
    lines.push(`- tags: ${pref.tags.length === 0 ? "none" : pref.tags.join(", ")}`);
    lines.push(`- source: ${pref.source}`);
    if (pref.supersedesId !== null) {
      lines.push(`- supersedes: ${pref.supersedesId}`);
    }
    lines.push(`- updated: ${pref.updatedAt}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function exportJson(ctx: StoreContext): string {
  ctx.ensureSchema();
  const preferences = allPreferences(ctx).map((preference) => ({
    preference,
    evidence: evidenceFor(ctx, preference.id),
  }));
  return `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), preferences }, null, 2)}\n`;
}

export function importJson(ctx: StoreContext, input: string): ImportReport {
  ctx.ensureSchema();
  const transfer = parsePreferenceExport(input);

  return ctx.db.transaction(() => {
    const report: ImportReport = {
      preferencesImported: 0,
      preferencesSkipped: 0,
      evidenceImported: 0,
      conflicts: 0,
    };
    const pendingSupersessions: Array<{ id: string; supersedesId: string }> = [];

    for (const item of transfer.preferences) {
      const existing = ctx.db.prepare("SELECT * FROM preferences WHERE id = ?").get(item.preference.id) as
        | Row
        | undefined;
      if (existing !== undefined) {
        if (!samePreference(rowToPreference(existing), item.preference)) {
          report.conflicts += 1;
          continue;
        }
        report.preferencesSkipped += 1;
      } else {
        insertPreference(ctx, { ...item.preference, supersedesId: null });
        report.preferencesImported += 1;
        if (item.preference.supersedesId !== null) {
          pendingSupersessions.push({ id: item.preference.id, supersedesId: item.preference.supersedesId });
        }
      }

      for (const evidence of item.evidence) {
        const byHash = ctx.db
          .prepare("SELECT preference_id FROM evidence WHERE evidence_hash = ?")
          .get(evidence.evidenceHash) as Row | undefined;
        if (byHash !== undefined) {
          if (byHash.preference_id !== item.preference.id) {
            report.conflicts += 1;
          }
          continue;
        }

        const byId = ctx.db.prepare("SELECT preference_id FROM evidence WHERE id = ?").get(evidence.id) as
          | Row
          | undefined;
        if (byId !== undefined) {
          report.conflicts += 1;
          continue;
        }

        insertEvidence(ctx, evidence);
        report.evidenceImported += 1;
      }
    }

    for (const supersession of pendingSupersessions) {
      if (!preferenceExists(ctx, supersession.supersedesId)) {
        report.conflicts += 1;
        continue;
      }
      ctx.db
        .prepare("UPDATE preferences SET supersedes_id = ? WHERE id = ?")
        .run(supersession.supersedesId, supersession.id);
    }

    return report;
  })();
}
