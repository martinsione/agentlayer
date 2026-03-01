import { Agent } from "../src/agent";
import { JustBashRuntime } from "../src/runtime/just-bash";
import { InMemorySessionStore } from "../src/store/memory";
import { BashTool } from "../src/tools/bash";
import { WebFetchTool } from "../src/tools/web-fetch";

const agent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime: new JustBashRuntime(),
  store: new InMemorySessionStore(),
  tools: [BashTool, WebFetchTool],
});

const session = await agent.createSession();

session
  .on("message", ({ message }) => {
    switch (message.role) {
      case "assistant":
        console.log(`\n[message: ${message.role}] ${JSON.stringify(message.content)}`);
        break;
      case "user":
        console.log(`\n[message: ${message.role}] ${JSON.stringify(message.content)}`);
        break;
      default:
        break;
    }
  })
  .on("tool_call", (e) => {
    if (e.name === "bash" && /rm -rf/.test(e.args.command as string)) {
      return { deny: "Blocked dangerous command" };
    }
  })
  .on("tool_result", (e) => {
    console.log(`\n[${e.name} ${e.isError ? "failed" : "done"}]`);
  });

await session.send("What OS is this? Use uname -a.");

await session.send("What did I ask you first?");

await session.send("How does it compare vs debian?");

await session.send("What is the weather in Tokyo?");

await session.send("whats your cwd?");
