// Interrupt a running turn with a new instruction (steer mode).
//
// The agent starts a slow task, but a steering message auto-denies
// pending tool calls and redirects the agent mid-turn.
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
  .on("text_delta", (e) => void process.stdout.write(e.delta))
  .on("tool_call", (e) => console.log(`\n> ${e.name}(${JSON.stringify(e.args)})`))
  .on("tool_result", (e) =>
    console.log(`[${e.isError ? "error" : "ok"}] ${e.result.slice(0, 120)}`),
  )
  .on("turn_end", () => console.log("\n--- turn end ---\n"));

// Start a slow task
session.send("List all files under /usr recursively with find.");

// Wait for the loop to begin, then steer to something else
await new Promise((r) => setTimeout(r, 100));
session.send("Actually, just tell me the current date.", { mode: "steer" });

await session.waitForIdle();
