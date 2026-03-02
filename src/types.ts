import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { LanguageModel, TextStreamPart } from "ai";

// Re-export AI SDK message types under shorter aliases
export type { ModelMessage } from "@ai-sdk/provider-utils";
export type { TextPart, ToolCallPart, ToolResultPart } from "@ai-sdk/provider-utils";

// Runtime — the key abstraction. Tools call runtime, never Node APIs.
export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type ExecOptions = {
  cwd?: string;
  /** Timeout in seconds. Runtime implementations must convert to milliseconds where needed. */
  timeout?: number;
  signal?: AbortSignal;
  /** Streaming callback — called with each chunk of combined stdout+stderr output. */
  onData?: (data: Buffer) => void;
};

export interface Runtime {
  readonly cwd: string;
  /**
   * Execute a shell command and return its result.
   *
   * **Error contract:**
   * - Non-zero exit codes MUST be resolved (not rejected) via `ExecResult.exitCode`.
   * - Abort SHOULD throw `RuntimeAbortError` or a `DOMException` with `name: "AbortError"`.
   * - Timeout SHOULD throw `RuntimeTimeoutError` or a `DOMException` with `name: "TimeoutError"`.
   */
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
  /** The session ID this tool is executing in (set when running inside a session). */
  sessionId?: string;
  /** The current message history (set when running inside a session). */
  messages?: readonly ModelMessage[];
};

/**
 * The return type of a tool's execute function.
 *
 * Tools can return either:
 * - A `Promise<string | ToolResult>` for simple one-shot execution.
 * - An `AsyncGenerator<string, string | ToolResult>` that yields progress
 *   strings and returns the final result. Each yielded string is forwarded
 *   as a `tool-progress` event.
 */
export type ToolExecuteReturn =
  | Promise<string | ToolResult>
  | AsyncGenerator<string, string | ToolResult>;

export interface Tool<TInput = any> {
  name: string;
  /** Human-readable display name for UIs. Falls back to name if not set. */
  label?: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(input: TInput, ctx: ToolContext): ToolExecuteReturn;
  /** When true, the before-tool-call hook fires with needsApproval: true. */
  needsApproval?: boolean | ((input: TInput) => boolean);
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
  list(): Promise<string[]>;
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
  toolLabel?: string;
  input: Record<string, unknown>;
  needsApproval: boolean;
};
export type ToolCallDecision = void | { deny: string } | { input: Record<string, unknown> };

export type AfterToolCallEvent = {
  toolCallId: string;
  toolName: string;
  toolLabel?: string;
  input: Record<string, unknown>;
} & (
  | { result: string; metadata?: Record<string, unknown>; error?: undefined }
  | { result?: undefined; error: Error }
);

export type AfterToolCallDecision = void | { result: string };

export type BeforeModelCallEvent = {
  instructions: string | undefined;
  tools: readonly Tool[];
  messages: readonly ModelMessage[];
};

export type BeforeModelCallDecision = void | { instructions?: string; tools?: Tool[] };

export type BeforeStopEvent = {
  messages: readonly ModelMessage[];
};
export type BeforeStopDecision = void | { preventStop: true };

/**
 * Public hook event map — uses kebab-case event names (standard for event
 * emitters, like DOM events).  Internally the loop uses a camelCase callback
 * interface (LoopHooks in loop.ts); Session.runLoop() bridges the two.
 */
export type HookEventMap = {
  "before-tool-call": { payload: BeforeToolCallEvent; decision: ToolCallDecision };
  "after-tool-call": { payload: AfterToolCallEvent; decision: AfterToolCallDecision };
  "before-model-call": { payload: BeforeModelCallEvent; decision: BeforeModelCallDecision };
  "before-stop": { payload: BeforeStopEvent; decision: BeforeStopDecision };
};

export type HookEvent = keyof HookEventMap;

export type HookListener<K extends HookEvent> = (
  event: HookEventMap[K]["payload"],
) => HookEventMap[K]["decision"] | Promise<HookEventMap[K]["decision"]>;

export type AgentHooks = {
  [K in HookEvent]?: HookListener<K> | HookListener<K>[];
};

export type MessageEvent =
  | { message: ModelMessage & { role: "user" } }
  | {
      message: ModelMessage & { role: "assistant" };
      usage: SessionUsage;
      finishReason: string;
    }
  | { message: ModelMessage & { role: "tool" } };

export type TurnEndEvent = { messages: ModelMessage[]; text: string };
export type ErrorEvent = { error: Error };

// Tool progress
export type ToolProgressEvent = {
  toolCallId: string;
  toolName: string;
  toolLabel?: string;
  text: string;
};

// Usage
export type SessionUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

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
  // Hooks (4)
  "before-tool-call": BeforeToolCallEvent;
  "after-tool-call": AfterToolCallEvent;
  "before-model-call": BeforeModelCallEvent;
  "before-stop": BeforeStopEvent;
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

/** Discriminated union of all session events — used by session.subscribe(). */
export type SessionEvent = {
  [K in keyof SessionEventMap]: { type: K } & SessionEventMap[K];
}[keyof SessionEventMap];

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

// Prompt result
export type PromptResult = {
  text: string;
  messages: readonly ModelMessage[];
  usage: SessionUsage;
};

// Send mode
export type SendMode = "steer" | "queue";

// Thinking / reasoning budgets
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export type ThinkingBudgets = {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
};

/** Configuration for auto-compaction. */
export type CompactionConfig = {
  /** Summarize the messages that need compaction. Called with messages to summarize. */
  summarize: (messages: readonly ModelMessage[]) => string | Promise<string>;
  /** Number of recent messages to keep uncompacted (default: 4). */
  keepLast?: number;
};

/** Configuration for a named subagent. */
export type SubagentConfig = {
  /** Description shown to the LLM for when to use this subagent. */
  description: string;
  /** System prompt / instructions for the subagent. */
  instructions?: string;
  /** Tools available to the subagent. If omitted, inherits parent tools. */
  tools?: Tool[];
  /** Model override. If omitted, inherits parent model. */
  model?: LanguageModel;
  /** Max steps for the subagent loop (default: 50). */
  maxSteps?: number;
};

// Options
export type SessionOptions = { sendMode?: SendMode };
export type AgentOptions = {
  model: LanguageModel;
  /** System prompt / instructions for the agent. */
  instructions?: string;
  tools?: Tool[];
  runtime?: Runtime;
  store?: SessionStore;
  maxSteps?: number; // default: 100
  sendMode?: SendMode;
  hooks?: AgentHooks;
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  /** Extra provider options passed to streamText (e.g. Anthropic thinking, OpenAI seed). */
  providerOptions?: Record<string, unknown>;
  /**
   * Transform the message context before each model call (e.g. pruning, compaction).
   * Receives a shallow copy of the message array. Do not mutate individual messages —
   * return new message objects if modification is needed.
   */
  transformContext?: (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>;
  /** Inline event handler — receives all session events. */
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Auto-compaction configuration. When provided, session.compact() can be called. */
  compaction?: CompactionConfig;
  /** Named subagent definitions. Each key becomes a `task_<name>` tool. */
  subagents?: Record<string, SubagentConfig>;
};
