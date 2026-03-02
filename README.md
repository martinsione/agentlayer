# agentlayer

Minimal agent framework on the [Vercel AI SDK](https://ai-sdk.dev). Pluggable runtimes, tools, and session storage with a typed event API.

## Install

```bash
npm install agentlayer
```

## Quick start

```ts
import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5", // any AI SDK LanguageModel
  instructions: "You are a helpful assistant.",
  tools: [BashTool],
});

// One-liner: send + wait + get text
const result = await agent.prompt("How many CPUs does this machine have?");
console.log(result.text);

// Or with streaming
await agent.prompt("How many CPUs?", {
  onText: (t) => process.stdout.write(t),
});
```

For multi-turn conversations, use sessions:

```ts
const session = await agent.createSession();
await session.prompt("How many CPUs?");
console.log(session.text); // last assistant reply

await session.prompt("And RAM?");
console.log(session.text); // updated after each turn
```

## Custom tools

Create type-safe tools with zod schemas via `defineTool`:

```ts
import { defineTool } from "agentlayer";
import { z } from "zod/v4";

const weather = defineTool({
  name: "get_weather",
  label: "Weather",
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  needsApproval: true, // fires before-tool-call with needsApproval: true
  execute: async (input) => {
    // input.city is typed as string
    const res = await fetch(`https://wttr.in/${input.city}?format=j1`);
    return JSON.stringify(await res.json());
  },
});

const agent = new Agent({ model, tools: [weather] });
```

Or implement the `Tool` interface directly without zod:

```ts
const echo: Tool = {
  name: "echo",
  description: "Echo the input",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (input) => input.text,
};
```

## Subagents

Define named subagents that become task tools automatically:

```ts
const agent = new Agent({
  model,
  tools: [BashTool, ReadTool, EditTool],
  subagents: {
    explore: {
      description: "Fast read-only codebase exploration",
      instructions: "Use grep and glob to find files quickly.",
      tools: [ReadTool, GlobTool, GrepTool],
    },
    plan: {
      description: "Create implementation plans",
      instructions: "Plan but don't edit files.",
      tools: [ReadTool, GlobTool],
    },
  },
});
// LLM can now call task_explore and task_plan tools
// Subagent text deltas are forwarded as tool-progress events
```

## Tool call hooks

Approve, deny, or modify tool calls before they execute:

```ts
session.on("before-tool-call", (e) => {
  // e.needsApproval is true if the tool declared needsApproval

  // Block dangerous commands
  if (e.toolName === "bash" && /rm -rf/.test(e.input.command as string)) {
    return { deny: "Blocked dangerous command" };
  }

  // Override arguments
  return { input: { ...e.input, timeout: 5000 } };
});
```

Hook events also include `toolLabel` (human-readable name) when available.

Other hooks: `after-tool-call` (includes `metadata` from tool results), `before-model-call`, `before-stop` (can return `{ preventStop: true }` to keep the loop running).

## Session persistence

Store sessions to disk and resume them later:

```ts
import { JsonlSessionStore } from "agentlayer/store/jsonl";

const agent = new Agent({
  model,
  tools: [BashTool],
  store: new JsonlSessionStore("./sessions"),
});

// First run
const session = await agent.createSession({ id: "my-session" });
await session.prompt("What OS is this?");

// Later: resume with full context
const resumed = await agent.resumeSession("my-session");
await resumed.prompt("And how much RAM does it have?");
```

## Compaction

Compact long conversations to stay within context limits:

```ts
const agent = new Agent({
  model,
  compaction: {
    summarize: async (msgs) => {
      /* call LLM to summarize */ return summary;
    },
    keepLast: 4,
  },
});

const session = await agent.createSession();
// ... many turns ...
await session.compact(); // summarizes old messages, keeps last 4
```

## Sending messages

`session.prompt()` sends and waits. For non-blocking control, use `send()`:

```ts
session.send("Hello"); // non-blocking, starts the loop
await session.waitForIdle(); // wait for completion
```

Interrupt or queue messages while the agent is running:

```ts
session.steer("Stop, do this instead"); // interrupts before next model call
session.followUp("Also do this"); // queues after current turn ends
```

Continue the loop without a new user message:

```ts
await session.continue(); // re-enters the loop from current state
```

## Events

Subscribe to individual events or all events at once:

```ts
// Individual events
const unsub = session.on("text-delta", (e) => process.stdout.write(e.text));

// All events via subscribe()
session.subscribe((event) => {
  if (event.type === "text-delta") process.stdout.write(event.text);
  if (event.type === "error") console.error(event.error);
});

// Or inline via agent config
const agent = new Agent({
  model,
  onEvent: (e) => {
    if (e.type === "text-delta") process.stdout.write(e.text);
  },
});
```

**Stream events** (from AI SDK): `text-start`, `text-delta`, `text-end`, `reasoning-start`, `reasoning-delta`, `reasoning-end`, `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call`, `tool-result`, `tool-error`.

**Framework events**: `message`, `turn-start`, `turn-end`, `error`, `status`, `tool-progress`, `step-start`, `step-end`.

**Hook events** (can return decisions): `before-tool-call`, `after-tool-call`, `before-model-call`, `before-stop`.

## Dynamic session properties

Change model, tools, instructions, or thinking level mid-session:

```ts
session.model = anotherModel;
session.tools = [BashTool, newTool];
session.instructions = "New instructions";
session.thinkingLevel = "high"; // "off" | "minimal" | "low" | "medium" | "high"
```

Changes take effect on the next turn.

## Token usage

```ts
const { inputTokens, outputTokens, totalTokens } = session.usage;
```

Accumulated across all model calls in the session.

## Runtimes

Tools call `ctx.runtime` instead of Node APIs directly, so you can swap execution environments:

```ts
import { NodeRuntime } from "agentlayer/runtime/node"; // default
import { VercelSandboxRuntime } from "agentlayer/runtime/sandbox"; // cloud
import { JustBashRuntime } from "agentlayer/runtime/just-bash"; // in-memory

new Agent({ model, runtime: new VercelSandboxRuntime({ sandbox }) });
```

## Agent options

```ts
const agent = new Agent({
  model,                              // LanguageModel (required)
  instructions: "You are a ...",      // system prompt
  tools: [BashTool, WebFetchTool],    // optional
  runtime: new NodeRuntime(),         // optional, default: NodeRuntime
  store: new InMemorySessionStore(),  // optional, default: InMemorySessionStore
  maxSteps: 100,                      // optional, default: 100
  sendMode: "steer",                  // "steer" | "queue", default: "steer"
  hooks: { ... },                     // AgentHooks, applied to all sessions
  onEvent: (e) => { ... },           // inline event handler for all events
  thinkingLevel: "medium",            // "off" | "minimal" | "low" | "medium" | "high"
  thinkingBudgets: { medium: 10000 }, // custom token budgets per level
  providerOptions: { ... },           // passed to streamText providerOptions
  transformContext: (msgs) => msgs,   // pre-model message transform
  compaction: { summarize, keepLast },// auto-compaction config
  subagents: { ... },                 // named subagent definitions
});
```

## Built-in tools

| Tool             | Import                       | Description                                        |
| ---------------- | ---------------------------- | -------------------------------------------------- |
| `BashTool`       | `agentlayer/tools/bash`      | Shell commands with output truncation and timeout  |
| `ReadTool`       | `agentlayer/tools/read`      | Read file contents (truncated to 100KB)            |
| `WriteTool`      | `agentlayer/tools/write`     | Write files (creates parent directories)           |
| `EditTool`       | `agentlayer/tools/edit`      | Search-and-replace with fuzzy matching             |
| `GlobTool`       | `agentlayer/tools/glob`      | Find files matching glob patterns                  |
| `GrepTool`       | `agentlayer/tools/grep`      | Search file contents with regex                    |
| `WebFetchTool`   | `agentlayer/tools/web-fetch` | HTTP GET/POST with 15s timeout and 50KB truncation |
| `createTaskTool` | `agentlayer/tools/task`      | Spawn a nested agent loop as a tool call           |

## Examples

```bash
npx tsx examples/basic.ts           # quickstart with custom tool
npx tsx examples/just-bash.ts       # sandboxed in-memory runtime
npx tsx examples/vercel-sandbox.ts  # cloud sandbox runtime
bun examples/tui.ts                 # full terminal UI chat app
```

## License

MIT
