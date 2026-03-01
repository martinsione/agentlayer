// Queue multiple messages for sequential processing.
//
// Each queued message keeps the loop alive for another turn after
// the current one finishes — useful for scripting a series of
// instructions without waiting for each individually.
//
// Run: npx tsx examples/queue.ts

import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";
import { attachLogger } from "./_log";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool],
  sendMode: "queue",
});

const session = await agent.createSession();

attachLogger(session);
session.on("turn-end", () => console.log("\n--- turn end ---\n"));

// Only the first message starts the loop; the rest queue up.
session.send("What OS is this? Use uname -a.");
session.send("How much disk space is free? Use df -h.");
session.send("What is the current uptime?");

await session.waitForIdle();
