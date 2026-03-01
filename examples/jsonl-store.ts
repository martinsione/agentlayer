import { Agent } from "../src/agent";
import { JustBashRuntime } from "../src/runtime/just-bash";
import { JsonlSessionStore } from "../src/store/jsonl";
import { BashTool } from "../src/tools/bash";

const store = new JsonlSessionStore("/tmp/agentlayer-sessions");

const agent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime: new JustBashRuntime(),
  store,
  tools: [BashTool],
});

// --- First run: create a session and chat ---
const session = await agent.createSession({ id: "demo" });

session
  .on("message", ({ message }) => {
    if (message.role === "assistant") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
      if (text) console.log(`\nassistant: ${text}`);
    }
  })
  .on("tool_result", (e) => {
    console.log(`\n[${e.name} ${e.isError ? "failed" : "done"}]`);
  });

console.log("--- New session ---");
session.send("What OS is this? Use uname -a.");
await session.waitForIdle();

session.send("And what shell?");
await session.waitForIdle();

// --- Second run: resume the same session ---
console.log("\n--- Resumed session ---");
const resumed = await agent.resumeSession("demo");

resumed
  .on("message", ({ message }) => {
    if (message.role === "assistant") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
      if (text) console.log(`\nassistant: ${text}`);
    }
  })
  .on("tool_result", (e) => {
    console.log(`\n[${e.name} ${e.isError ? "failed" : "done"}]`);
  });

resumed.send("What did I ask you first?");
await resumed.waitForIdle();
