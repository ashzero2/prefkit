export interface UserPromptSubmitInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
  agent?: string;
}

export interface LearnerEvent {
  agent: string;
  cwd: string;
  sessionId?: string;
  eventType: "explicit_memory" | "explicit_correction" | "user_prompt";
  userPrompt: string;
  assistantSummary: string;
  repoContext: Record<string, unknown>;
  metadata: Record<string, string>;
}

export function parseUserPromptSubmitInput(value: unknown): UserPromptSubmitInput | null;
export function shouldQueuePrompt(prompt: string): boolean;
export function buildLearnerEvent(input: UserPromptSubmitInput, env?: Record<string, string | undefined>): LearnerEvent;
export function buildQueueArgs(env?: Record<string, string | undefined>): string[];
export function buildWorkerArgs(env?: Record<string, string | undefined>): string[];
