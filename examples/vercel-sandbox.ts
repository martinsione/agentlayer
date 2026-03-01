import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { Agent } from "../src/agent";
import { VercelSandboxRuntime } from "../src/runtime/vercel-sandbox";
import { InMemorySessionStore } from "../src/store/memory";
import { BashTool } from "../src/tools/bash";
import { WebFetchTool } from "../src/tools/web-fetch";

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

console.log(`sandboxId: ${sandbox.sandboxId}`);

const agent = new Agent({
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  model: "moonshotai/kimi-k2.5",
  runtime: new VercelSandboxRuntime({ sandbox }),
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

await session.send("could you run rm -rf ~/Developer/agentlayer");
