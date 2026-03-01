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
import { attachLogger } from "./_log";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  runtime: new JustBashRuntime(),
  tools: [BashTool, WebFetchTool],
});

const session = await agent.createSession();

attachLogger(session);

session.send("What OS is this? Use uname -a.");
await session.waitForIdle();

session.send("What is your working directory?");
await session.waitForIdle();
console.log();
