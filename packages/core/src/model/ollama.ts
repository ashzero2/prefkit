import type { LocalModelConfig } from "../config/types.js";
import type { ModelHealth, PrefKitModel } from "./types.js";

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export class OllamaModel implements PrefKitModel {
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
}
