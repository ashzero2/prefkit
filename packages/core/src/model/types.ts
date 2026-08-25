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
