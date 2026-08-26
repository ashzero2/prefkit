import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, OllamaModel } from "../../src/index.js";
import type { LocalModelConfig, ModelJsonRequest } from "../../src/index.js";

describe("OllamaModel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates structured JSON with the native chat endpoint", async () => {
    const fetchMock = mockFetch(
      Response.json({
        message: {
          content: JSON.stringify({ shouldLearn: false }),
        },
        prompt_eval_count: 42,
        eval_count: 7,
      }),
    );
    const model = new OllamaModel(config());

    const result = await model.generateJson(request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:11434/api/chat");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3:4b",
      messages: [{ role: "user", content: "Extract a preference." }],
      stream: false,
      format: { type: "object", properties: { shouldLearn: { type: "boolean" } } },
      options: {
        temperature: 0,
        num_predict: 64,
      },
    });
    expect(result).toEqual({
      json: { shouldLearn: false },
      rawText: "{\"shouldLearn\":false}",
      usage: {
        inputTokens: 42,
        outputTokens: 7,
      },
    });
  });

  it("passes configured thinking mode when requested", async () => {
    const fetchMock = mockFetch(
      Response.json({
        message: {
          content: JSON.stringify({ shouldLearn: false }),
        },
      }),
    );
    const model = new OllamaModel(config({ think: "low" }));

    await model.generateJson(request());

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      think: "low",
    });
  });

  it("throws on HTTP errors", async () => {
    mockFetch(new Response("nope", { status: 500 }));
    const model = new OllamaModel(config());

    await expect(model.generateJson(request())).rejects.toThrow("Ollama returned HTTP 500.");
  });

  it("throws when message content is missing", async () => {
    mockFetch(Response.json({ done: true }));
    const model = new OllamaModel(config());

    await expect(model.generateJson(request())).rejects.toThrow("message.content");
  });

  it("throws when message content is not valid JSON", async () => {
    mockFetch(Response.json({ message: { content: "not json" } }));
    const model = new OllamaModel(config());

    await expect(model.generateJson(request())).rejects.toThrow("Ollama returned invalid JSON");
  });

  it("converts aborts into timeout errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const model = new OllamaModel(config({ timeoutMs: 25 }));

    const promise = model.generateJson(request());
    const expectation = expect(promise).rejects.toThrow("Ollama request timed out after 25 ms.");
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
  });
});

function config(overrides: Partial<LocalModelConfig> = {}): LocalModelConfig {
  return {
    ...defaultConfig.localModel,
    maxOutputTokens: 64,
    ...overrides,
  };
}

function request(): ModelJsonRequest {
  return {
    messages: [{ role: "user", content: "Extract a preference." }],
    schema: {
      type: "object",
      properties: {
        shouldLearn: { type: "boolean" },
      },
    },
    temperature: 0,
    maxOutputTokens: 64,
  };
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
