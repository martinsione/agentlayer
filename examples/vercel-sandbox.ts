// Run an agent inside a cloud-sandboxed environment.
//
// Requires: @vercel/sandbox (npm i @vercel/sandbox)
// Run: npx tsx examples/vercel-sandbox.ts

import { Sandbox } from "@vercel/sandbox";
import { Agent } from "agentlayer";
import { VercelSandboxRuntime } from "agentlayer/runtime/sandbox";
import { BashTool } from "agentlayer/tools/bash";
import { attachLogger } from "./_log";

const sandbox = await Sandbox.create({ runtime: "node24" });
console.log(`Sandbox: ${sandbox.sandboxId}\n`);

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  runtime: new VercelSandboxRuntime({ sandbox }),
  tools: [BashTool],
});

const session = await agent.createSession();

attachLogger(session);

session.send("What OS and Node.js version are in this sandbox? Use uname -a && node -v.");
await session.waitForIdle();
console.log("\n");
