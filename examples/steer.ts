// Interrupt a running turn with a new instruction (steer mode).
//
// The agent starts a slow task, but a steering message redirects
// the agent between steps.
//
// Run: npx tsx examples/steer.ts

import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool],
});

const session = await agent.createSession();

session
  .on("text-delta", (e) => void process.stdout.write(e.text))
  .on("before-tool-call", (e) => console.log(`\n> ${e.toolName}(${JSON.stringify(e.input)})`))
  .on("tool-result", (e) => console.log(`[ok] ${String(e.output).slice(0, 120)}`))
  .on("tool-error", (e) => console.log(`[error] ${String(e.error).slice(0, 120)}`))
  .on("turn-end", () => console.log("\n--- turn end ---\n"));

// Start a slow task
session.send("List all files under /usr recursively with find.");

// Wait for the loop to begin, then steer to something else
await new Promise((r) => setTimeout(r, 100));
session.send("Actually, just tell me the current date.", { mode: "steer" });

await session.waitForIdle();
