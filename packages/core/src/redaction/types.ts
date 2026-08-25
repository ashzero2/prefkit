import type { PrivacyConfig } from "../config/types.js";
import type { LearnerEvent } from "../learner/schemas.js";

export type RedactionKind =
  | "private-key"
  | "github-token"
  | "openai-token"
  | "anthropic-token"
  | "aws-access-key-id"
  | "bearer-token"
  | "connection-url-credentials"
  | "secret-assignment"
  | "truncation";

export interface RedactionFinding {
  kind: RedactionKind;
  path: string;
}

export interface RedactedText {
  value: string;
  findings: RedactionFinding[];
}

export interface RedactedLearnerEvent {
  event: LearnerEvent;
  findings: RedactionFinding[];
}

export type RedactionOptions = Pick<PrivacyConfig, "redactSecrets" | "maxEvidenceChars">;
