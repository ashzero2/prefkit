export interface ModelHealth {
  ok: boolean;
  provider: string;
  model: string;
  message: string;
  latencyMs?: number;
}

export interface PrefKitModel {
  name(): string;
  health(): Promise<ModelHealth>;
}

export type ModelJsonMessageRole = "system" | "user" | "assistant";

export interface ModelJsonMessage {
  role: ModelJsonMessageRole;
  content: string;
}

export interface ModelJsonRequest {
  messages: ModelJsonMessage[];
  schema: unknown;
  temperature: number;
  maxOutputTokens: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelJsonResult {
  json: unknown;
  rawText?: string;
  usage?: ModelUsage;
}

export interface PrefKitJsonModel {
  name(): string;
  generateJson(request: ModelJsonRequest): Promise<ModelJsonResult>;
}
