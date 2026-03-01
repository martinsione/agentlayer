import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { LanguageModel, TextStreamPart } from "ai";

// Re-export AI SDK message types under shorter aliases
export type { ModelMessage } from "@ai-sdk/provider-utils";
export type { TextPart, ToolCallPart, ToolResultPart } from "@ai-sdk/provider-utils";

// Runtime — the key abstraction. Tools call runtime, never Node APIs.
export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type ExecOptions = {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  /** Streaming callback — called with each chunk of combined stdout+stderr output. */
  onData?: (data: Buffer) => void;
};

export interface Runtime {
  readonly cwd: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

// Tool
export type ToolResult = { output: string; metadata?: Record<string, unknown> };

export type ToolContext = {
  runtime: Runtime;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
};

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolResult>;
}

// Session entries — tree-based model with id/parentId on every entry
export type SessionEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: number;
};

export type MessageEntry = SessionEntryBase & {
  type: "message";
  message: ModelMessage;
};

export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptId: string;
};

export type SessionEntry = MessageEntry | CompactionEntry;

// Store
export interface SessionStore {
  load(sessionId: string): Promise<SessionEntry[]>;
  append(sessionId: string, entry: SessionEntry): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}

// Stream event types — extracted from AI SDK TextStreamPart
type StreamPart<T extends TextStreamPart<any>["type"]> = Extract<TextStreamPart<any>, { type: T }>;

export type TextStartEvent = StreamPart<"text-start">;
export type TextDeltaEvent = StreamPart<"text-delta">;
export type TextEndEvent = StreamPart<"text-end">;
export type ReasoningStartEvent = StreamPart<"reasoning-start">;
export type ReasoningDeltaEvent = StreamPart<"reasoning-delta">;
export type ReasoningEndEvent = StreamPart<"reasoning-end">;
export type ToolInputStartEvent = StreamPart<"tool-input-start">;
export type ToolInputDeltaEvent = StreamPart<"tool-input-delta">;
export type ToolInputEndEvent = StreamPart<"tool-input-end">;
export type ToolCallStreamEvent = StreamPart<"tool-call">;
export type ToolResultStreamEvent = StreamPart<"tool-result">;
export type ToolErrorStreamEvent = StreamPart<"tool-error">;

// Framework event payloads
export type TurnStartEvent = {};

export type BeforeToolCallEvent = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
export type ToolCallDecision =
  | void
  | undefined
  | { deny: string }
  | { input: Record<string, unknown> };

export type AfterToolCallEvent = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
} & ({ result: string; error?: undefined } | { result?: undefined; error: Error });

export type AfterToolCallDecision = void | undefined | { result: string };

export type BeforeModelCallEvent = {
  system: string | undefined;
  tools: readonly Tool[];
  messages: readonly ModelMessage[];
};

export type BeforeModelCallDecision = void | undefined | { system?: string; tools?: Tool[] };

export type HookEventMap = {
  "before-tool-call": { payload: BeforeToolCallEvent; decision: ToolCallDecision };
  "after-tool-call": { payload: AfterToolCallEvent; decision: AfterToolCallDecision };
  "before-model-call": { payload: BeforeModelCallEvent; decision: BeforeModelCallDecision };
};

export type HookEvent = keyof HookEventMap;

export type HookListener<K extends HookEvent> = (
  event: HookEventMap[K]["payload"],
) => void | HookEventMap[K]["decision"] | Promise<void | HookEventMap[K]["decision"]>;

export type AgentHooks = {
  [K in HookEvent]?: HookListener<K> | HookListener<K>[];
};

export type MessageEvent =
  | { message: ModelMessage & { role: "user" } }
  | {
      message: ModelMessage & { role: "assistant" };
      usage: { input: number; output: number };
      finishReason: string;
    }
  | { message: ModelMessage & { role: "tool" } };

export type TurnEndEvent = { messages: ModelMessage[]; text: string };
export type ErrorEvent = { error: Error };

// Tool progress
export type ToolProgressEvent = { toolCallId: string; toolName: string; text: string };

// Status
export type SessionStatus = "idle" | "busy";
export type StatusEvent = { status: SessionStatus };

// Step boundary events
export type StepStartEvent = { step: number };
export type StepEndEvent = { step: number };

export type SessionEventMap = {
  // AI SDK stream pass-through (12)
  "text-start": TextStartEvent;
  "text-delta": TextDeltaEvent;
  "text-end": TextEndEvent;
  "reasoning-start": ReasoningStartEvent;
  "reasoning-delta": ReasoningDeltaEvent;
  "reasoning-end": ReasoningEndEvent;
  "tool-input-start": ToolInputStartEvent;
  "tool-input-delta": ToolInputDeltaEvent;
  "tool-input-end": ToolInputEndEvent;
  "tool-call": ToolCallStreamEvent;
  "tool-result": ToolResultStreamEvent;
  "tool-error": ToolErrorStreamEvent;
  // Hooks (3)
  "before-tool-call": BeforeToolCallEvent;
  "after-tool-call": AfterToolCallEvent;
  "before-model-call": BeforeModelCallEvent;
  // Events (8)
  message: MessageEvent;
  "turn-start": TurnStartEvent;
  "turn-end": TurnEndEvent;
  error: ErrorEvent;
  status: StatusEvent;
  "tool-progress": ToolProgressEvent;
  "step-start": StepStartEvent;
  "step-end": StepEndEvent;
};

// Loop events — what the loop yields
export const STREAM_EVENT_TYPES = [
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "tool-result",
  "tool-error",
] as const;

type YieldedStreamPart = Extract<
  TextStreamPart<any>,
  { type: (typeof STREAM_EVENT_TYPES)[number] }
>;

export type LoopEvent =
  | YieldedStreamPart
  | ({ type: "message" } & MessageEvent)
  | ({ type: "step-start" } & StepStartEvent)
  | ({ type: "step-end" } & StepEndEvent);

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
  hooks?: AgentHooks;
};
