// Run an agent inside a cloud-sandboxed environment.
//
// Requires: @vercel/sandbox (npm i @vercel/sandbox)
// Run: npx tsx examples/vercel-sandbox.ts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { Agent } from "agentlayer";
import { VercelSandboxRuntime } from "agentlayer/runtime/sandbox";
import { BashTool } from "agentlayer/tools/bash";

async function getOrCreateSandbox() {
  const lockFilePath = path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "agentlayer",
    "vercel-sandbox.lock",
  );
  const sandboxId = await fs.readFile(lockFilePath, "utf-8").catch(() => null);

  if (sandboxId) {
    try {
      const sb = await Sandbox.get({ sandboxId: sandboxId.trim() });
      // Health check — Sandbox.get() can return a handle to a dead sandbox
      await sb.runCommand({ cmd: "true" });
      return sb;
    } catch {
      // Sandbox expired or unreachable — fall through to create
    }
  }

  const ONE_HOUR_IN_MS = 60 * 60 * 1000;
  const sandbox = await Sandbox.create({ runtime: "node24", timeout: 5 * ONE_HOUR_IN_MS });
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
  await fs.writeFile(lockFilePath, sandbox.sandboxId);
  return sandbox;
}

const sandbox = await getOrCreateSandbox();

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  instructions: "You are a helpful assistant. Use tools when needed. Be concise.",
  runtime: new VercelSandboxRuntime({ sandbox }),
  tools: [BashTool],
  onEvent: (e) => {
    if (e.type === "text-delta") process.stdout.write(e.text);
    if (e.type === "before-tool-call")
      console.log(`\n> ${e.toolLabel ?? e.toolName}(${JSON.stringify(e.input)})`);
    if (e.type === "tool-result") console.log(`[ok] ${String(e.output).slice(0, 120)}`);
    if (e.type === "tool-error") console.log(`[error] ${String(e.error).slice(0, 120)}`);
  },
});

await agent.prompt("What OS and Node.js version are in this sandbox? Use uname -a && node -v.");
console.log("\n");
