import type { LocalModelConfig } from "../config/types.js";
import type { ModelHealth, ModelJsonRequest, ModelJsonResult, PrefKitJsonModel, PrefKitModel } from "./types.js";

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaModel implements PrefKitModel, PrefKitJsonModel {
  constructor(private readonly config: LocalModelConfig) {}

  name(): string {
    return `ollama:${this.config.model}`;
  }

  async health(): Promise<ModelHealth> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs, 5000));

    try {
      const response = await fetch(new URL("/api/tags", this.config.baseUrl), {
        method: "GET",
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        return {
          ok: false,
          provider: "ollama",
          model: this.config.model,
          latencyMs,
          message: `Ollama returned HTTP ${response.status}.`,
        };
      }

      const body = (await response.json()) as OllamaTagsResponse;
      const models = body.models ?? [];
      const found = models.some((entry) => {
        return entry.name === this.config.model || entry.model === this.config.model;
      });

      return {
        ok: found,
        provider: "ollama",
        model: this.config.model,
        latencyMs,
        message: found
          ? "Ollama is reachable and the configured model is installed."
          : "Ollama is reachable, but the configured model was not found.",
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: "ollama",
        model: this.config.model,
        latencyMs,
        message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateJson(request: ModelJsonRequest): Promise<ModelJsonResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(new URL("/api/chat", this.config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          stream: false,
          think: false,
          format: request.schema,
          options: {
            temperature: request.temperature,
            num_predict: request.maxOutputTokens,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
      }

      const body = (await response.json()) as OllamaChatResponse;
      const content = body.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("Ollama response did not include message.content.");
      }

      return {
        json: parseJsonContent(content),
        rawText: content,
        usage: {
          ...(typeof body.prompt_eval_count === "number" ? { inputTokens: body.prompt_eval_count } : {}),
          ...(typeof body.eval_count === "number" ? { outputTokens: body.eval_count } : {}),
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Ollama request timed out after ${this.config.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Ollama returned invalid JSON: ${message}`);
  }
}
