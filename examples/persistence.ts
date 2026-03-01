// Persist sessions to disk and resume them across process restarts.
//
// JsonlSessionStore writes one JSON entry per line to {dir}/{sessionId}.jsonl.
// Survives crashes — malformed lines are skipped on load.
//
// Run: npx tsx examples/persistence.ts

import { Agent } from "agentlayer";
import { JsonlSessionStore } from "agentlayer/store/jsonl";
import { BashTool } from "agentlayer/tools/bash";

const store = new JsonlSessionStore("/tmp/agentlayer-sessions");

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool],
  store,
});

function onDelta(e: { text: string }) {
  process.stdout.write(e.text);
}

// --- First conversation ---
console.log("--- New session ---\n");

const session = await agent.createSession({ id: "demo" });
session.on("text-delta", onDelta);

session.send("What OS is this? Use uname -a.");
await session.waitForIdle();
console.log("\n");

session.send("And what shell am I using?");
await session.waitForIdle();

// --- Resume later ---
console.log("\n\n--- Resumed session ---\n");

const resumed = await agent.resumeSession("demo");
resumed.on("text-delta", onDelta);

resumed.send("What did I ask you first?");
await resumed.waitForIdle();
console.log("\n");
