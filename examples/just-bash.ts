// In-process bash runtime — no child processes, no filesystem.
//
// JustBashRuntime runs commands in a sandboxed bash interpreter
// with an in-memory filesystem. Useful for lightweight agents
// that don't need real OS access.
//
// Requires: just-bash (npm i just-bash)
// Run: npx tsx examples/just-bash.ts

import { Agent } from "agentlayer";
import { JustBashRuntime } from "agentlayer/runtime/just-bash";
import { BashTool } from "agentlayer/tools/bash";
import { WebFetchTool } from "agentlayer/tools/web-fetch";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  runtime: new JustBashRuntime(),
  tools: [BashTool, WebFetchTool],
});

const session = await agent.createSession();

session.on("text-delta", (e) => void process.stdout.write(e.text));
session.on("before-tool-call", (e) => console.log(`\n> ${e.toolName}(${JSON.stringify(e.input)})`));
session.on("tool-result", (e) => console.log(`[ok] ${String(e.output).slice(0, 120)}\n`));
session.on("tool-error", (e) => console.log(`[error] ${String(e.error).slice(0, 120)}\n`));

session.send("What OS is this? Use uname -a.");
await session.waitForIdle();

session.send("What is your working directory?");
await session.waitForIdle();
console.log();
