// Quickstart: agent with built-in + custom tools, streaming, and hooks.
//
// Run: npx tsx examples/basic.ts

import { Agent } from "agentlayer";
import { defineTool } from "agentlayer/define-tool";
import { BashTool } from "agentlayer/tools/bash";
import { z } from "zod";

const dateTool = defineTool({
  name: "current_date",
  description: "Return the current date and time",
  schema: z.object({}),
  execute: async () => new Date().toISOString(),
});

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  instructions: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool, dateTool],
  onEvent: (e) => {
    if (e.type === "text-delta") process.stdout.write(e.text);
    if (e.type === "before-tool-call") console.log(`\n> ${e.toolName}(${JSON.stringify(e.input)})`);
    if (e.type === "tool-result") console.log(`[ok] ${String(e.output).slice(0, 120)}`);
    if (e.type === "tool-error") console.log(`[error] ${String(e.error).slice(0, 120)}`);
  },
});

await agent.prompt("How many CPUs does this machine have? Also, what's today's date?");
console.log();
