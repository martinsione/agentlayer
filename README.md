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
  model: "anthropic/claude-sonnet-4-20250514", // any AI SDK LanguageModel
  tools: [BashTool],
});

const session = await agent.createSession();
session.on("text-delta", (e) => process.stdout.write(e.text));

session.send("How many CPUs does this machine have?");
await session.waitForIdle();
```

## Custom tools

Create type-safe tools with zod schemas via `defineTool`:

```ts
import { defineTool } from "agentlayer/define-tool";
import { z } from "zod/v4";

const weather = defineTool({
  name: "get_weather",
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

Other hooks: `after-tool-call`, `before-model-call`, `before-stop` (can return `{ preventStop: true }` to keep the loop running).

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
session.send("What OS is this?");
await session.waitForIdle();

// Later: resume with full context
const resumed = await agent.resumeSession("my-session");
resumed.send("And how much RAM does it have?");
await session.waitForIdle();
```

## Send modes

`send()` is non-blocking and accepts `string`, `ModelMessage`, or `ModelMessage[]`:

```ts
// Simple text
session.send("Hello");

// Pre-built message (images, multi-part content)
session.send({ role: "user", content: [{ type: "image", image: buf }] });
```

Control what happens when you send while the agent is running:

- **Steer** (default) — interrupt: `session.send("Do this instead", { mode: "steer" })`
- **Queue** — sequential: `new Agent({ model, sendMode: "queue" })`

## Dynamic session properties

Change model, tools, system prompt, or thinking level mid-session:

```ts
session.model = anotherModel;
session.tools = [BashTool, newTool];
session.systemPrompt = "New instructions";
session.thinkingLevel = "high"; // "off" | "minimal" | "low" | "medium" | "high"
```

Changes take effect on the next turn.

## Token usage

```ts
const { inputTokens, outputTokens, totalTokens } = session.usage;
```

Accumulated across all model calls in the session.

## Context transformation

Transform the message context before each model call (pruning, compaction, injection):

```ts
const agent = new Agent({
  model,
  transformContext: (messages) => {
    // messages is a shallow copy — return a new array, don't mutate in place
    if (messages.length > 50) return messages.slice(-20);
    return messages;
  },
});
```

## Events

`session.on()` returns an unsubscribe function:

```ts
const unsub = session.on("text-delta", (e) => process.stdout.write(e.text));
// later: unsub();
```

**Stream events** (from AI SDK): `text-start`, `text-delta`, `text-end`, `reasoning-start`, `reasoning-delta`, `reasoning-end`, `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call`, `tool-result`, `tool-error`.

**Framework events**: `message`, `turn-start`, `turn-end`, `error`, `status`, `tool-progress`, `step-start`, `step-end`.

**Hook events** (can return decisions): `before-tool-call`, `after-tool-call`, `before-model-call`, `before-stop`.

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
  systemPrompt: "You are a ...",      // optional
  tools: [BashTool, WebFetchTool],    // optional
  runtime: new NodeRuntime(),         // optional, default: NodeRuntime
  store: new InMemorySessionStore(),  // optional, default: InMemorySessionStore
  maxSteps: 100,                      // optional, default: 100
  sendMode: "steer",                  // "steer" | "queue", default: "steer"
  hooks: { ... },                     // AgentHooks, applied to all sessions
  thinkingLevel: "medium",            // "off" | "minimal" | "low" | "medium" | "high"
  thinkingBudgets: { medium: 10000 }, // custom token budgets per level
  providerOptions: { ... },           // passed to streamText providerOptions
  transformContext: (msgs) => msgs,   // pre-model message transform
});
```

## Built-in tools

| Tool           | Import                       | Description                                        |
| -------------- | ---------------------------- | -------------------------------------------------- |
| `BashTool`     | `agentlayer/tools/bash`      | Shell commands with output truncation and timeout  |
| `ReadTool`     | `agentlayer/tools/read`      | Read file contents (truncated to 100KB)            |
| `WriteTool`    | `agentlayer/tools/write`     | Write files (creates parent directories)           |
| `GlobTool`     | `agentlayer/tools/glob`      | Find files matching glob patterns                  |
| `GrepTool`     | `agentlayer/tools/grep`      | Search file contents with regex                    |
| `WebFetchTool` | `agentlayer/tools/web-fetch` | HTTP GET/POST with 15s timeout and 50KB truncation |
| `TaskTool`     | `agentlayer/tools/task`      | Spawn a nested agent loop as a tool call           |

## Examples

```bash
npx tsx examples/basic.ts           # quickstart with custom tool
npx tsx examples/just-bash.ts       # sandboxed in-memory runtime
npx tsx examples/vercel-sandbox.ts  # cloud sandbox runtime
bun examples/tui.ts                 # full terminal UI chat app
```

## License

MIT
