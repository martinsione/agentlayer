# agentlayer

Minimal agent framework on the [Vercel AI SDK](https://ai-sdk.dev). Pluggable runtimes, tools, and session storage with a typed event API.

## Quick start

```ts
import { Agent } from "agentlayer/agent";
import { NodeRuntime } from "agentlayer/runtime/node";
import { BashTool } from "agentlayer/tools/bash";

const agent = new Agent({
  model: gateway("anthropic/claude-sonnet-4"),
  runtime: new NodeRuntime(),
  tools: [BashTool],
});

const session = await agent.createSession();

session.on("text_delta", (e) => {
  process.stdout.write(e.delta);
});

session.on("tool_call", (e) => {
  if (e.name === "bash" && /rm -rf/.test(e.args.command as string)) {
    return { deny: "Blocked dangerous command" };
  }
});

session.on("tool_result", (e) => {
  console.log(`${e.name} ${e.isError ? "failed" : "done"}`);
});

session.send("How many CPUs does this machine have?");
await session.waitForIdle();

session.send("What about RAM?");
await session.waitForIdle();
```

## Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │               Agent                        │
                          │  model · tools · runtime · store · config  │
                          └────────────────┬────────────────────────────┘
                                           │ createSession() / resumeSession()
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                              Session                                     │
│                                                                          │
│  .send(text, opts?)      ──► routes into steeringQueue or followUpQueue  │
│  .waitForIdle()          ──► resolves when loop settles                  │
│  .on(event, listener)    ◄── typed events (SessionEventMap)              │
│  .off(event, listener)                                                   │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     loop()  ·  two-way async generator                   │
│                                                                          │
│  ── drain point 1: inject steering messages ──                           │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────┐    ┌────────────┐  │
│  │ streamText│──►│ yield deltas │──►│ yield message│──►│ yield step  │  │
│  └──────────┘    │  (text_delta)│    │  (assistant) │    │(usage/finish│  │
│       ▲          └──────────────┘    └──────────────┘    └─────┬──────┘  │
│       │                                                        │         │
│       │  ┌─────────────────────────────────────────────────────┘         │
│       │  │  tool calls?                                                  │
│       │  │  no ── drain point 3: check follow-up queue ── break/continue │
│       │  │  yes ▼                                                        │
│       │  Phase 1: yield tool_call ──► receive decision via .next()       │
│       │     └─ drain point 2: steering? auto-deny remaining tool calls   │
│       │  Phase 2: execute approved tools in parallel (Promise.all)       │
│       │  Phase 3: yield tool_result for each                             │
│       │  │                                                               │
│       └──┘  loop back                                                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
   ┌─────────┐            ┌──────────────┐           ┌──────────────┐
   │ Runtime  │            │    Tools     │           │    Store     │
   │          │            │              │           │              │
   │ .exec()  │◄───────── │ .execute()   │           │ .load()      │
   │ .readFile│  ctx.      │              │           │ .append()    │
   │ .writeFile            │ BashTool     │           │ .exists()    │
   │          │            │ WebFetchTool │           │              │
   │ Node     │            │ defineTool() │           │ InMemory     │
   │ Sandbox  │            └──────────────┘           │ (or custom)  │
   │ JustBash │                                       └──────────────┘
   └─────────┘
```

### Agent

Entry point. Wraps model, tools, runtime, and config. Creates sessions.

```ts
const agent = new Agent({
  model, // LanguageModel from AI SDK (required)
  systemPrompt: "You are ...", // optional
  tools: [BashTool], // optional, default: []
  runtime: new NodeRuntime(), // optional, default: NodeRuntime
  store: new InMemorySessionStore(), // optional, default: InMemorySessionStore
  maxSteps: 100, // optional, default: 100
  sendMode: "steer", // optional, default: "steer"
});
```

- `agent.createSession(opts?)` — new session. Accepts `{ id?: string; sendMode?: SendMode }`. Auto-generates ID if omitted.
- `agent.resumeSession(id, opts?)` — load from store, throws if not found. Accepts optional `{ sendMode?: SendMode }`.

### Session

Multi-turn conversation with persistence and typed events.

- `session.send(text, opts?)` — fire-and-forget: routes the user message into the loop. Accepts `{ mode?: SendMode; signal?: AbortSignal }`. Returns `void`.
- `session.waitForIdle()` — returns `Promise<void>` that resolves when the loop finishes (or immediately if idle). Rejects if the loop errors.
- `session.on(event, listener)` — register a typed event listener, returns `this` for chaining
- `session.off(event, listener)` — remove a listener

### Send modes

`send()` is non-blocking. What happens depends on whether the loop is idle or running:

| State                         | Behavior                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Loop idle                     | Starts a new loop with the message                                                     |
| Loop running, `mode: "steer"` | Injects before the next model turn. Auto-denies any pending tool calls.                |
| Loop running, `mode: "queue"` | Queues the message. Processed after the current turn finishes, keeping the loop alive. |

The default mode is `"steer"` unless overridden at the agent or per-call level.

**Steer** — interrupt a running agent:

```ts
session.send("List all files under /usr recursively");

// While the agent is running, redirect it
await new Promise((r) => setTimeout(r, 100));
session.send("Actually, just tell me the date.", { mode: "steer" });

await session.waitForIdle();
```

**Queue** — script a series of instructions:

```ts
const agent = new Agent({ model, tools: [BashTool], sendMode: "queue" });
const session = await agent.createSession();

session.send("What OS is this? Use uname -a.");
session.send("How much disk space is free?");
session.send("What is the current uptime?");

await session.waitForIdle(); // all three processed sequentially
```

### Events

7 events. All listeners can be async. Only `tool_call` can return a value.

| Event         | Payload                                      | Return                           | When                                        |
| ------------- | -------------------------------------------- | -------------------------------- | ------------------------------------------- |
| `text_delta`  | `{ delta: string }`                          | void                             | Streaming text fragment                     |
| `message`     | `{ message: ModelMessage }`                  | void                             | User or assistant message                   |
| `tool_call`   | `{ callId, name, args }`                     | void \| `{ deny }` \| `{ args }` | Before tool execution (can block or modify) |
| `tool_result` | `{ callId, name, result, isError }`          | void                             | After tool execution                        |
| `step`        | `{ usage: { input, output }, finishReason }` | void                             | One LLM round-trip completed                |
| `turn_end`    | `{ messages: ModelMessage[], text: string }` | void                             | Loop finished (all turns processed)         |
| `error`       | `{ error: Error }`                           | void                             | Something broke                             |

**Event flow** for a turn with tool use:

```
message      (user)
text_delta   × N
message      (assistant)
step
tool_call    × N            ← all tool calls yielded first (approval phase)
tool_result  × N            ← all results yielded after (parallel execution)
text_delta   × N            ← next LLM call
message      (assistant)
step
turn_end
```

**`tool_call` interception:**

```ts
session.on("tool_call", (e) => {
  if (dangerous(e)) return { deny: "Not allowed" };
  if (needsOverride(e)) return { args: { ...e.args, timeout: 5000 } };
  // return nothing to allow
});
```

Each tool call is evaluated independently. When multiple `tool_call` listeners are registered, they run in order — the first listener to return `{ deny }` or `{ args }` decides the outcome, and the rest are skipped for that call.

## Tool loop internals

`loop()` in `loop.ts` is a two-way async generator (`AsyncGenerator<LoopEvent, void, ToolCallDecision>`).

Each step:

1. **Drain point 1** — injects any pending steering messages before the model call
2. Calls `streamText()`, yields `text_delta` as fragments arrive
3. Assembles the assistant message (text + tool calls), yields `message`
4. Awaits usage/finishReason, yields `step`
5. If no tool calls → **drain point 3**: checks for follow-up messages. If any, pushes them and continues the loop. Otherwise, the loop ends.
6. **Phase 1** — yields each `tool_call`, receives a decision via `.next()`. **Drain point 2**: if steering messages arrive mid-phase, auto-denies remaining tool calls.
7. **Phase 2** — executes all approved tools in parallel via `Promise.all`
8. **Phase 3** — yields each `tool_result` in order. Deferred steering messages are pushed after tool results to maintain valid message ordering.
9. Loops back to step 1

The loop mutates the `messages` array directly (passed by reference). The session persists each message to the store as events arrive.

## Runtime

Tools never touch Node APIs directly — they call `ctx.runtime.exec()`, `ctx.runtime.readFile()`, etc.

```ts
interface Runtime {
  readonly cwd: string;
  exec(command: string, opts?: { cwd?; timeout?; signal? }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
```

Three built-in runtimes:

- **NodeRuntime** (`agentlayer/runtime/node`) — local machine via `child_process.spawn` + `fs/promises`. Truncates stdout/stderr at 1MB.
- **VercelSandboxRuntime** (`agentlayer/runtime/sandbox`) — [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), requires `@vercel/sandbox` peer dep
- **JustBashRuntime** (`agentlayer/runtime/just-bash`) — in-process bash interpreter via [just-bash](https://github.com/nicolo-ribaudo/just-bash), requires `just-bash` peer dep. Used in tests.

## Tools

```ts
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
```

Built-in: **BashTool** (shell commands), **WebFetchTool** (HTTP requests, 15s timeout, 50KB truncation).

### `defineTool`

Use `defineTool()` to create tools with typed input via zod:

```ts
import { z } from "zod";
import { defineTool } from "agentlayer/define-tool";

const greet = defineTool({
  name: "greet",
  description: "Say hello",
  schema: z.object({ name: z.string() }),
  execute: async (input, ctx) => {
    return `Hello, ${input.name}!`; // input.name is typed as string
  },
});
```

The zod schema is converted to JSON Schema for `parameters`. You can also implement the `Tool` interface directly with a plain object if you don't want zod.

## Session store

```ts
interface SessionStore {
  load(sessionId: string): Promise<ModelMessage[]>;
  append(sessionId: string, message: ModelMessage): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}
```

Default: **InMemorySessionStore** (backed by `Map`, lost on process exit).

## File structure

```
src/
  types.ts          — all type definitions (events, options, interfaces)
  agent.ts          — Agent class (creates/resumes sessions)
  session.ts        — Session class (on/off/send, drives the loop)
  loop.ts           — two-way async generator (streamText + tool execution)
  define-tool.ts    — defineTool() helper (zod → Tool)
  index.ts          — barrel re-exports
  runtime/
    node.ts         — NodeRuntime (child_process + fs)
    vercel-sandbox.ts — VercelSandboxRuntime (@vercel/sandbox)
    just-bash.ts    — JustBashRuntime (in-process bash)
  store/
    memory.ts       — InMemorySessionStore
  tools/
    bash.ts         — BashTool
    web-fetch.ts    — WebFetchTool
```
