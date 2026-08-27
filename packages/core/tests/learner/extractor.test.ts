import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  extractPreference,
} from "../../src/index.js";
import type {
  ModelJsonRequest,
  ModelJsonResult,
  PreferenceExtractionOptions,
  PrefKitJsonModel,
} from "../../src/index.js";

describe("preference extractor runner", () => {
  it("skips weak events before calling the model", async () => {
    const model = new MockJsonModel(validModelOutput());
    const result = await extractPreference(
      {
        agent: "claude",
        eventType: "user_prompt",
        userPrompt: "Can you add a test for this helper?",
        assistantSummary: "",
      },
      model,
      options(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected extraction to be skipped.");
    }
    expect(result.status).toBe("learning_skipped");
    expect(model.requests).toHaveLength(0);
    expect(result.errors).toEqual(["signal-below-threshold"]);
  });

  it("extracts a preference from redacted evidence and scores it deterministically", async () => {
    const model = new MockJsonModel(validModelOutput(), {
      inputTokens: 120,
      outputTokens: 80,
    });
    const result = await extractPreference(
      {
        agent: "claude",
        cwd: "/repo",
        eventType: "explicit_correction",
        userPrompt: "No, use pnpm here. token=secret-token-value-123456",
        assistantSummary: "Suggested npm install.",
        metadata: {
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        },
      },
      model,
      options(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.schema).toMatchObject({ type: "object" });
    expect(model.requests[0]?.temperature).toBe(defaultConfig.localModel.temperature);
    expect(JSON.stringify(model.requests[0]?.messages)).not.toContain("secret-token-value-123456");
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("[REDACTED:secret-assignment]");
    expect(result.redactions.map((finding) => finding.kind)).toContain("secret-assignment");
    expect(result.redactions.map((finding) => finding.kind)).toContain("bearer-token");
    expect(result.extraction.statement).toBe("Prefer pnpm for JavaScript package management.");
    expect(result.confidence.status).toBe("active");
    expect(result.confidence.confidence).toBe(0.75);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 80 });
  });

  it("normalizes reusable task guidance to global scope", async () => {
    const model = new MockJsonModel({
      shouldLearn: true,
      statement: "For app-naming tasks, always give 10 name options first.",
      scopeType: "task",
      scopeValue: "session-123",
      category: "naming",
      tags: ["app-naming", "output-quantity"],
      evidenceType: "USER_EXPLICIT",
      polarity: "positive",
      proposedStatus: "candidate",
      needsConfirmation: true,
      rationale: "The user gave reusable naming workflow guidance.",
      contradictions: [],
    });
    const result = await extractPreference(
      {
        agent: "opencode",
        sessionId: "session-123",
        eventType: "user_prompt",
        userPrompt: "For app-naming tasks, always give me 10 name options first so I can choose one.",
        assistantSummary: "",
      },
      model,
      options(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.extraction.scopeType).toBe("global");
    expect(result.extraction.scopeValue).toBeNull();
    expect(result.confidence.confidence).toBe(0.75);
    expect(result.confidence.status).toBe("candidate");
  });

  it("keeps one-off task guidance task-scoped", async () => {
    const model = new MockJsonModel({
      shouldLearn: true,
      statement: "For this task, always give 10 name options first.",
      scopeType: "task",
      scopeValue: "session-123",
      category: "naming",
      tags: ["app-naming", "output-quantity"],
      evidenceType: "USER_EXPLICIT",
      polarity: "positive",
      proposedStatus: "candidate",
      needsConfirmation: true,
      rationale: "The user gave guidance for the current task.",
      contradictions: [],
    });
    const result = await extractPreference(
      {
        agent: "opencode",
        sessionId: "session-123",
        eventType: "user_prompt",
        userPrompt: "For this task, always give me 10 name options first.",
        assistantSummary: "",
      },
      model,
      options(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.extraction.scopeType).toBe("task");
    expect(result.extraction.scopeValue).toBe("session-123");
  });

  it("rejects malformed model output without calculating confidence", async () => {
    const model = new MockJsonModel({
      shouldLearn: true,
      statement: null,
      scopeType: "repository",
      scopeValue: "/repo",
      category: "tooling",
      evidenceType: "USER_EXPLICIT",
      polarity: "positive",
      rationale: "Malformed output.",
    });
    const result = await extractPreference(
      {
        agent: "claude",
        eventType: "explicit_correction",
        userPrompt: "No, use pnpm here.",
        assistantSummary: "Suggested npm.",
      },
      model,
      options(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected model output to be rejected.");
    }
    expect(result.status).toBe("invalid_model_output");
    expect(result.errors.join("\n")).toContain("statement is required");
  });

  it("skips oversized prompts before calling the model", async () => {
    const model = new MockJsonModel(validModelOutput());
    const result = await extractPreference(
      {
        agent: "claude",
        eventType: "explicit_memory",
        userPrompt: "Remember that I prefer pnpm.",
        assistantSummary: "",
      },
      model,
      options({
        localModel: {
          ...defaultConfig.localModel,
          maxInputTokens: 1,
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected oversized input to be skipped.");
    }
    expect(result.status).toBe("input_too_large");
    expect(model.requests).toHaveLength(0);
    expect(result.promptTokenEstimate).toBeGreaterThan(1);
  });

  it("returns model errors as non-throwing extraction results", async () => {
    const model = new MockJsonModel(new Error("model unavailable"));
    const result = await extractPreference(
      {
        agent: "claude",
        eventType: "explicit_correction",
        userPrompt: "No, use pnpm here.",
        assistantSummary: "Suggested npm.",
      },
      model,
      options(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected model error result.");
    }
    expect(result.status).toBe("model_error");
    expect(result.errors).toEqual(["model unavailable"]);
  });
});

class MockJsonModel implements PrefKitJsonModel {
  readonly requests: ModelJsonRequest[] = [];

  constructor(
    private readonly output: unknown,
    private readonly usage?: ModelJsonResult["usage"],
  ) {}

  name(): string {
    return "mock-json-model";
  }

  async generateJson(request: ModelJsonRequest): Promise<ModelJsonResult> {
    this.requests.push(request);
    if (this.output instanceof Error) {
      throw this.output;
    }
    return {
      json: this.output,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    };
  }
}

function options(overrides: Partial<PreferenceExtractionOptions> = {}): PreferenceExtractionOptions {
  return {
    learning: defaultConfig.learning,
    privacy: defaultConfig.privacy,
    localModel: defaultConfig.localModel,
    ...overrides,
  };
}

function validModelOutput(): unknown {
  return {
    shouldLearn: true,
    statement: "Prefer pnpm for JavaScript package management.",
    scopeType: "repository",
    scopeValue: "/repo",
    category: "tooling",
    tags: ["javascript", "package-manager", "pnpm"],
    evidenceType: "USER_EXPLICIT",
    polarity: "positive",
    rationale: "The user directly corrected npm to pnpm.",
    contradictions: [],
  };
}
