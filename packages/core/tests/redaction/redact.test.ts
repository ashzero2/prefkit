import { describe, expect, it } from "vitest";
import { redactLearnerEvent, redactText, validateLearnerEvent } from "../../src/index.js";

const options = {
  redactSecrets: true,
  maxEvidenceChars: 120,
};

const longOptions = {
  redactSecrets: true,
  maxEvidenceChars: 1000,
};

describe("redaction", () => {
  it("redacts common token and credential shapes from text", () => {
    const input = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "DATABASE_URL=postgres://user:password@example.com/db",
      "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
    ].join("\n");

    const redacted = redactText(input, longOptions);

    expect(redacted.value).toContain("Bearer [REDACTED:bearer-token]");
    expect(redacted.value).toContain("OPENAI_API_KEY=[REDACTED:openai-token]");
    expect(redacted.value).toContain("ANTHROPIC_API_KEY=[REDACTED:anthropic-token]");
    expect(redacted.value).toContain("GITHUB_TOKEN=[REDACTED:github-token]");
    expect(redacted.value).toContain("postgres://[REDACTED:connection-url-credentials]@example.com/db");
    expect(redacted.value).toContain("[REDACTED:aws-access-key-id]");
    expect(redacted.value).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.findings.map((finding) => finding.kind)).toContain("openai-token");
    expect(redacted.findings.map((finding) => finding.kind)).toContain("anthropic-token");
  });

  it("redacts generic secret assignments", () => {
    const redacted = redactText("password=hunter2secret token=internal-token-value", longOptions);

    expect(redacted.value).toContain("password=[REDACTED:secret-assignment]");
    expect(redacted.value).toContain("token=[REDACTED:secret-assignment]");
    expect(redacted.findings.map((finding) => finding.kind)).toContain("secret-assignment");
  });

  it("redacts private key blocks", () => {
    const redacted = redactText(
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      options,
      "metadata.privateKey",
    );

    expect(redacted.value).toBe("[REDACTED:private-key]");
    expect(redacted.findings).toEqual([{ kind: "private-key", path: "metadata.privateKey" }]);
  });

  it("truncates oversized evidence", () => {
    const redacted = redactText("x".repeat(130), options, "userPrompt");

    expect(redacted.value).toHaveLength(131);
    expect(redacted.value.endsWith("[TRUNCATED]")).toBe(true);
    expect(redacted.findings).toContainEqual({ kind: "truncation", path: "userPrompt" });
  });

  it("redacts learner events recursively without storing raw findings", () => {
    const eventResult = validateLearnerEvent({
      agent: "claude",
      eventType: "explicit_correction",
      userPrompt: "No, use pnpm. token=secret-token-value-123456",
      assistantSummary: "Suggested npm install.",
      repoContext: {
        env: {
          DATABASE_URL: "postgres://user:password@example.com/db",
        },
      },
      metadata: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
    });

    expect(eventResult.ok).toBe(true);
    if (!eventResult.ok) {
      return;
    }

    const redacted = redactLearnerEvent(eventResult.value, options);

    expect(redacted.event.userPrompt).toContain("token=[REDACTED:secret-assignment]");
    expect(redacted.event.repoContext).toEqual({
      env: {
        DATABASE_URL: "postgres://[REDACTED:connection-url-credentials]@example.com/db",
      },
    });
    expect(redacted.event.metadata.authorization).toBe("Bearer [REDACTED:bearer-token]");
    expect(JSON.stringify(redacted.findings)).not.toContain("password");
    expect(redacted.findings).toContainEqual({ kind: "connection-url-credentials", path: "repoContext.env.DATABASE_URL" });
  });

  it("can leave text untouched when secret redaction is disabled", () => {
    const redacted = redactText("token=secret-token-value-123456", {
      redactSecrets: false,
      maxEvidenceChars: 120,
    });

    expect(redacted.value).toBe("token=secret-token-value-123456");
    expect(redacted.findings).toEqual([]);
  });
});
