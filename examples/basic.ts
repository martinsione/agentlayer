// Minimal agent: send a message, stream the response.
//
// Run: npx tsx examples/basic.ts

import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool],
});

const session = await agent.createSession();
session.on("text_delta", (e) => void process.stdout.write(e.delta));

session.send("How many CPUs does this machine have?");
await session.waitForIdle();
console.log();
