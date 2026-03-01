import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

// Re-export AI SDK message types under shorter aliases
export type { ModelMessage } from "@ai-sdk/provider-utils";
export type { TextPart, ToolCallPart, ToolResultPart } from "@ai-sdk/provider-utils";

// Runtime — the key abstraction. Tools call runtime, never Node APIs.
export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export interface Runtime {
  readonly cwd: string;
  exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

// Tool
export type ToolContext = { runtime: Runtime; signal?: AbortSignal };

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Store
export interface SessionStore {
  load(sessionId: string): Promise<ModelMessage[]>;
  append(sessionId: string, message: ModelMessage): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}

// Event payloads
export type TextDeltaEvent = { delta: string };
export type MessageEvent = { message: ModelMessage };
export type ToolCallEvent = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};
export type ToolCallDecision =
  | void
  | undefined
  | { deny: string }
  | { args: Record<string, unknown> };
export type ToolResultEvent = {
  callId: string;
  name: string;
  result: string;
  isError: boolean;
};
export type StepEvent = {
  usage: { input: number; output: number };
  finishReason: string;
};
export type TurnEndEvent = { messages: ModelMessage[]; text: string };
export type ErrorEvent = { error: Error };

export type SessionEventMap = {
  text_delta: TextDeltaEvent;
  message: MessageEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  step: StepEvent;
  turn_end: TurnEndEvent;
  error: ErrorEvent;
};

// Loop events — what the loop yields (composed from SessionEventMap types)
export type LoopEvent =
  | ({ type: "text_delta" } & TextDeltaEvent)
  | ({ type: "message" } & MessageEvent)
  | ({ type: "tool_call" } & ToolCallEvent)
  | ({ type: "tool_result" } & ToolResultEvent & { message: ModelMessage })
  | ({ type: "step" } & StepEvent);

// Send mode
export type SendMode = "steer" | "queue";

// Options
export type SessionOptions = { sendMode?: SendMode };
export type AgentOptions = {
  model: LanguageModel;
  systemPrompt?: string;
  tools?: Tool[];
  runtime?: Runtime;
  store?: SessionStore;
  maxSteps?: number; // default: 100
  sendMode?: SendMode;
};
