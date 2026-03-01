// Steer mode: interrupt a running turn with a new instruction.
//
// The agent starts a slow task (`find /usr -type f`), but we steer it
// mid-turn to do something different. The steering message auto-denies
// any pending tool calls and injects before the next model turn.
//
// Run: npx tsx examples/steer.ts

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

// --- Start a long-running task ---

session.send("List all files recursively under /usr using `find /usr -type f`.");

// Wait briefly for the loop to begin, then steer mid-turn.
await new Promise((r) => setTimeout(r, 100));

session.send("Actually, forget that. Just tell me the current date instead.", {
  mode: "steer",
});

// Wait until the agent finishes the steered turn.
await session.waitForIdle();
