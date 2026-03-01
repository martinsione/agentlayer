// Quickstart: agent with built-in + custom tools, streaming, and hooks.
//
// Run: npx tsx examples/basic.ts

import { Agent } from "agentlayer";
import { defineTool } from "agentlayer/define-tool";
import { BashTool } from "agentlayer/tools/bash";
import { z } from "zod";
import { attachLogger } from "./_log";

const dateTool = defineTool({
  name: "current_date",
  description: "Return the current date and time",
  schema: z.object({}),
  execute: async () => new Date().toISOString(),
});

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool, dateTool],
});

const session = await agent.createSession();
attachLogger(session);

session.send("How many CPUs does this machine have? Also, what's today's date?");
await session.waitForIdle();
console.log();
