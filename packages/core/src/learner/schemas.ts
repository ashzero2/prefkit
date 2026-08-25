import * as z from "zod";
export const learnerEventTypeSchema = z.enum([
  "explicit_memory",
  "explicit_correction",
  "user_prompt",
  "repeated_choice",
  "manual_replay",
]);

export const learnerEventSchema = z
  .object({
    agent: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    eventType: learnerEventTypeSchema,
    userPrompt: z.string().default(""),
    assistantSummary: z.string().default(""),
    repoContext: z.record(z.string(), z.unknown()).default({}),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const contradictionKindSchema = z.enum(["same_scope", "narrower_scope_exception", "broader_scope_update"]);
export const contradictionActionSchema = z.enum(["supersede_existing", "keep_both", "needs_review"]);

export const extractorOutputSchema = z
  .object({
    shouldLearn: z.boolean(),
    statement: z.string().trim().min(1).nullable(),
    scopeType: z.enum(["global", "repository", "path", "task", "agent"]),
    scopeValue: z.string().trim().min(1).nullable(),
    category: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).max(8).default([]),
    evidenceType: z.enum(["USER_EXPLICIT", "MODEL_EXTRACTED", "AGENT_EVENT", "IMPORT"]),
    polarity: z.enum(["positive", "negative", "neutral"]),
    proposedStatus: z.enum(["candidate", "active"]).default("candidate"),
    needsConfirmation: z.boolean().default(true),
    rationale: z.string().trim().min(1),
    contradictions: z
      .array(
        z
          .object({
            preferenceId: z.string().trim().min(1),
            kind: contradictionKindSchema,
            action: contradictionActionSchema,
            rationale: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.shouldLearn && value.statement === null) {
      context.addIssue({
        code: "custom",
        path: ["statement"],
        message: "statement is required when shouldLearn is true.",
      });
    }

    if (!value.shouldLearn && value.contradictions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["contradictions"],
        message: "contradictions require shouldLearn to be true.",
      });
    }
  });

export type LearnerEventType = z.infer<typeof learnerEventTypeSchema>;
export type LearnerEvent = z.infer<typeof learnerEventSchema>;
export type ExtractorOutput = z.infer<typeof extractorOutputSchema>;
export type ContradictionKind = z.infer<typeof contradictionKindSchema>;
export type ContradictionAction = z.infer<typeof contradictionActionSchema>;

export const extractorJsonSchema = z.toJSONSchema(extractorOutputSchema);

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateLearnerEvent(input: unknown): ValidationResult<LearnerEvent> {
  return validationResult(learnerEventSchema.safeParse(input));
}

export function validateExtractorOutput(input: unknown): ValidationResult<ExtractorOutput> {
  const parsed = extractorOutputSchema.safeParse(input);
  if (!parsed.success) {
    return validationResult(parsed);
  }

  return {
    ok: true,
    value: {
      ...parsed.data,
      proposedStatus: conservativeStatus(parsed.data.proposedStatus),
      needsConfirmation: true,
    },
  };
}

type SafeParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

function validationResult<T>(result: SafeParseResult<T>): ValidationResult<T> {
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    }),
  };
}

function conservativeStatus(status: "candidate" | "active"): "candidate" {
  if (status === "active") {
    return "candidate";
  }
  return status;
}
