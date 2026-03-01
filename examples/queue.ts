// Queue mode: fire off multiple messages that process sequentially.
//
// Each queued message keeps the loop alive for another turn after the
// current one finishes. This is useful for scripting a series of
// instructions without waiting for each to complete individually.
//
// Run: npx tsx examples/queue.ts

import { Agent } from "../src/agent";
import { JustBashRuntime } from "../src/runtime/just-bash";
import { InMemorySessionStore } from "../src/store/memory";
import { BashTool } from "../src/tools/bash";

const agent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime: new JustBashRuntime(),
  store: new InMemorySessionStore(),
  tools: [BashTool],
  sendMode: "queue", // default mode for all sessions created by this agent
});

const session = await agent.createSession();

// --- Wire up event listeners ---

session
  .on("text_delta", ({ delta }) => {
    process.stdout.write(delta);
  })
  .on("tool_call", (e) => console.log(`\n[tool_call: ${e.name}] ${JSON.stringify(e.args)}`))
  .on("tool_result", (e) =>
    console.log(`[tool_result: ${e.isError ? "error" : "ok"}] ${e.result.slice(0, 100)}`),
  )
  .on("turn_end", () => console.log("\n--- turn end ---\n"));

// --- Fire off three messages ---
// Only the first starts the loop; the rest queue up and process in order.

session.send("What OS is this? Use uname -a.");
session.send("How much disk space is free? Use df -h.");
session.send("What is the current uptime?");

// Wait for all queued messages to finish.
await session.waitForIdle();
