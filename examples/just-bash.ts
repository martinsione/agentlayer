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
  instructions: "You are a helpful assistant. Use tools when needed. Be concise.",
  runtime: new JustBashRuntime(),
  tools: [BashTool, WebFetchTool],
  onEvent: (e) => {
    if (e.type === "text-delta") process.stdout.write(e.text);
    if (e.type === "before-tool-call")
      console.log(`\n> ${e.toolLabel ?? e.toolName}(${JSON.stringify(e.input)})`);
    if (e.type === "tool-result") console.log(`[ok] ${String(e.output).slice(0, 120)}`);
    if (e.type === "tool-error") console.log(`[error] ${String(e.error).slice(0, 120)}`);
  },
});

await agent.prompt("What OS is this? Use uname -a.");
await agent.prompt("What is your working directory?");
console.log();
