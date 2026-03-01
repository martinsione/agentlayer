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
  tools: [BashTool],
});

const session = await agent.createSession();

session.on("text_delta", (e) => process.stdout.write(e.delta));

session.send("How many CPUs does this machine have?");
await session.waitForIdle();
```

## Custom tools

Create type-safe tools with zod schemas:

```ts
import { defineTool } from "agentlayer/define-tool";
import { z } from "zod/v4";

const weather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async (input) => {
    const res = await fetch(`https://wttr.in/${input.city}?format=j1`);
    const data = await res.json();
    return JSON.stringify(data.current_condition[0]);
  },
});

const agent = new Agent({ model, tools: [weather] });
```

Or implement the `Tool` interface directly without zod:

```ts
const echo = {
  name: "echo",
  description: "Echo the input",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (input) => input.text,
};
```

## Tool call interception

Approve, deny, or modify tool calls before they execute:

```ts
session.on("tool_call", (e) => {
  // Block dangerous commands
  if (e.name === "bash" && /rm -rf/.test(e.args.command)) {
    return { deny: "Blocked dangerous command" };
  }

  // Override arguments
  if (e.name === "bash") {
    return { args: { ...e.args, timeout: 5000 } };
  }

  // Return nothing to allow as-is
});
```

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
session.on("text_delta", (e) => process.stdout.write(e.delta));
session.send("What OS is this?");
await session.waitForIdle();

// Later: resume with full context
const resumed = await agent.resumeSession("my-session");
resumed.on("text_delta", (e) => process.stdout.write(e.delta));
resumed.send("And how much RAM does it have?");
await resumed.waitForIdle();
```

## Send modes

`send()` is non-blocking. Control what happens when you send a message while the agent is running:

**Steer** (default) — interrupt a running agent:

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

session.send("What OS is this?");
session.send("How much disk space is free?");
session.send("What is the current uptime?");

await session.waitForIdle(); // all three processed sequentially
```

## Events

7 typed events. All listeners can be async. Only `tool_call` can return a value.

```ts
session.on("text_delta", (e) => {
  process.stdout.write(e.delta);
});

session.on("message", (e) => {
  console.log(e.message.role, e.message.content);
});

session.on("tool_call", (e) => {
  // Return { deny: string } to block, { args } to override, or nothing to allow
});

session.on("tool_result", (e) => {
  console.log(`${e.name} ${e.isError ? "failed" : "done"}`);
});

session.on("step", (e) => {
  console.log(`tokens: ${e.usage.input}in / ${e.usage.output}out`);
});

session.on("turn_end", (e) => {
  console.log("final text:", e.text);
});

session.on("error", (e) => {
  console.error(e.error);
});
```

## Runtimes

Tools call `ctx.runtime` instead of Node APIs directly, so you can swap execution environments:

```ts
import { NodeRuntime } from "agentlayer/runtime/node";
import { VercelSandboxRuntime } from "agentlayer/runtime/sandbox";

// Local machine (default)
new Agent({ model, runtime: new NodeRuntime() });

// Vercel Sandbox (requires @vercel/sandbox)
new Agent({ model, runtime: new VercelSandboxRuntime() });
```

Implement the `Runtime` interface for custom environments:

```ts
interface Runtime {
  readonly cwd: string;
  exec(command: string, opts?: { cwd?; timeout?; signal? }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
```

## Agent options

```ts
const agent = new Agent({
  model, // LanguageModel (required)
  systemPrompt: "You are a ...", // optional
  tools: [BashTool, WebFetchTool], // optional, default: []
  runtime: new NodeRuntime(), // optional, default: NodeRuntime
  store: new InMemorySessionStore(), // optional, default: InMemorySessionStore
  maxSteps: 100, // optional, default: 100
  sendMode: "steer", // optional, default: "steer"
});
```

## Built-in tools

| Tool           | Import                       | Description                                        |
| -------------- | ---------------------------- | -------------------------------------------------- |
| `BashTool`     | `agentlayer/tools/bash`      | Shell commands with output truncation and timeout  |
| `WebFetchTool` | `agentlayer/tools/web-fetch` | HTTP GET/POST with 15s timeout and 50KB truncation |

## License

MIT
