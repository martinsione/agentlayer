import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { Agent } from "../src/agent";
import { VercelSandboxRuntime } from "../src/runtime/vercel-sandbox";
import { InMemorySessionStore } from "../src/store/memory";
import { BashTool } from "../src/tools/bash";

async function getOrCreateSandbox() {
  const lockFilePath = path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "agentlayer",
    "vercel-sandbox.lock",
  );
  const sandboxId = await fs.readFile(lockFilePath, "utf-8").catch(() => null);

  if (sandboxId) {
    try {
      return await Sandbox.get({ sandboxId: sandboxId.trim() });
    } catch {}
  }

  const ONE_HOUR_IN_MS = 60 * 60 * 1000;
  const sandbox = await Sandbox.create({ runtime: "node24", timeout: 5 * ONE_HOUR_IN_MS });
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
  await fs.writeFile(lockFilePath, sandbox.sandboxId);
  return sandbox;
}

const sandbox = await getOrCreateSandbox();
console.log(`sandboxId: ${sandbox.sandboxId}\n`);

const runtime = new VercelSandboxRuntime({ sandbox });

// ---------------------------------------------------------------------------
// Steer mode (default): interrupt a running turn with a new instruction.
// The agent is doing work (running `find`), but we steer it mid-turn to
// do something else instead. The steering message skips pending tool calls
// and injects before the next model turn.
// ---------------------------------------------------------------------------
console.log("=== STEER MODE ===\n");

const steerAgent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime,
  store: new InMemorySessionStore(),
  tools: [BashTool],
});

const steerSession = await steerAgent.createSession();

steerSession
  .on("text_delta", ({ delta }) => {
    process.stdout.write(delta);
  })
  .on("tool_call", (e) => console.log(`\n[tool_call: ${e.name}] ${JSON.stringify(e.args)}`))
  .on("tool_result", (e) =>
    console.log(`[tool_result: ${e.isError ? "error" : "ok"}] ${e.result.slice(0, 100)}`),
  )
  .on("turn_end", () => console.log("\n--- turn end ---\n"));

// Start a slow task
steerSession.send("List all files recursively under /usr/lib. Use find.");

// While that's running, steer the agent to do something different
await new Promise((r) => setTimeout(r, 100));
steerSession.send("Actually, forget that. Just tell me the current date instead.", {
  mode: "steer",
});

await steerSession.waitForIdle();

// ---------------------------------------------------------------------------
// Queue mode: stack messages that process sequentially after the current turn.
// Each queued message keeps the loop alive for another turn — useful for
// scripting a series of instructions without waiting for each to finish.
// ---------------------------------------------------------------------------
console.log("\n=== QUEUE MODE ===\n");

const queueAgent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime,
  store: new InMemorySessionStore(),
  tools: [BashTool],
  sendMode: "queue", // default mode for this agent's sessions
});

const queueSession = await queueAgent.createSession();

queueSession
  .on("text_delta", ({ delta }) => {
    process.stdout.write(delta);
  })
  .on("tool_call", (e) => console.log(`\n[tool_call: ${e.name}] ${JSON.stringify(e.args)}`))
  .on("tool_result", (e) =>
    console.log(`[tool_result: ${e.isError ? "error" : "ok"}] ${e.result.slice(0, 100)}`),
  )
  .on("turn_end", () => console.log("\n--- turn end ---\n"));

// Fire off three messages — only the first starts the loop, the rest queue up.
// They process in order: each one waits for the previous turn to finish.
queueSession.send("What OS is this? Use uname -a.");
queueSession.send("How much disk space is free? Use df -h.", { mode: "queue" });
queueSession.send("What is the current uptime?", { mode: "queue" });

// Wait for all queued messages to be processed.
await queueSession.waitForIdle();
