import type { LearnerEvent } from "../learner/schemas.js";
import type { RedactedLearnerEvent, RedactedText, RedactionFinding, RedactionKind, RedactionOptions } from "./types.js";

interface RedactionPattern {
  kind: RedactionKind;
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
}

const secretPatterns: RedactionPattern[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    kind: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,255}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    kind: "github-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    kind: "anthropic-token",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/g,
    replacement: "[REDACTED:anthropic-token]",
  },
  {
    kind: "openai-token",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g,
    replacement: "[REDACTED:openai-token]",
  },
  {
    kind: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED:aws-access-key-id]",
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    replacement: "Bearer [REDACTED:bearer-token]",
  },
  {
    kind: "connection-url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: (...args: string[]) => `${args[1] ?? ""}[REDACTED:connection-url-credentials]@`,
  },
  {
    kind: "secret-assignment",
    pattern:
      /\b(api[_-]?key|auth(?:orization)?|client[_-]?secret|password|passwd|pwd|secret|token)\b(\s*[:=]\s*)(["']?)([^\s"',;]{8,})(["']?)/gi,
    replacement: (...args: string[]) => {
      const key = args[1] ?? "";
      const separator = args[2] ?? "";
      const quoteStart = args[3] ?? "";
      const quoteEnd = args[5] ?? "";
      return `${key}${separator}${quoteStart}[REDACTED:secret-assignment]${quoteEnd}`;
    },
  },
];

export function redactText(input: string, options: RedactionOptions, path = "text"): RedactedText {
  let value = input;
  const findings: RedactionFinding[] = [];

  if (options.redactSecrets) {
    for (const entry of secretPatterns) {
      const before = value;
      value = value.replace(entry.pattern, (...args: string[]) => {
        findings.push({ kind: entry.kind, path });
        if (typeof entry.replacement === "string") {
          return entry.replacement;
        }
        return entry.replacement(...args);
      });

      if (before === value) {
        entry.pattern.lastIndex = 0;
      }
    }
  }

  if (value.length > options.maxEvidenceChars) {
    value = `${value.slice(0, Math.max(0, options.maxEvidenceChars))}[TRUNCATED]`;
    findings.push({ kind: "truncation", path });
  }

  return { value, findings };
}

export function redactLearnerEvent(event: LearnerEvent, options: RedactionOptions): RedactedLearnerEvent {
  const findings: RedactionFinding[] = [];
  const userPrompt = redactText(event.userPrompt, options, "userPrompt");
  const assistantSummary = redactText(event.assistantSummary, options, "assistantSummary");
  const repoContext = redactUnknown(event.repoContext, options, "repoContext", findings);
  const metadata = redactUnknown(event.metadata, options, "metadata", findings);

  findings.push(...userPrompt.findings, ...assistantSummary.findings);

  const redacted: LearnerEvent = {
    ...event,
    userPrompt: userPrompt.value,
    assistantSummary: assistantSummary.value,
    repoContext: isJsonObject(repoContext) ? repoContext : {},
    metadata: isJsonObject(metadata) ? metadata : {},
  };

  return { event: redacted, findings };
}

function redactUnknown(
  value: unknown,
  options: RedactionOptions,
  path: string,
  findings: RedactionFinding[],
): unknown {
  if (typeof value === "string") {
    const redacted = redactText(value, options, path);
    findings.push(...redacted.findings);
    return redacted.value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, options, `${path}.${index}`, findings));
  }

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactUnknown(child, options, `${path}.${key}`, findings)]),
    );
  }

  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
