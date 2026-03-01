// Intercept tool calls to block dangerous commands or modify arguments.
//
// The before-tool-call event fires before execution. Return { deny } to block
// a call, { input } to override arguments, or nothing to allow it.
//
// Run: npx tsx examples/tool-guard.ts

import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool],
});

const session = await agent.createSession();

session
  .on("text-delta", (e) => void process.stdout.write(e.text))
  .on("before-tool-call", (e) => {
    const cmd = e.input.command as string;

    // Block destructive commands
    if (/\brm\s/.test(cmd)) {
      console.log(`\n[BLOCKED] ${cmd}`);
      return { deny: "rm is not allowed" };
    }

    // Add a timeout to find commands
    if (/\bfind\b/.test(cmd) && !e.input.timeout) {
      console.log(`\n[MODIFIED] added 10s timeout: ${cmd}`);
      return { input: { ...e.input, timeout: 10 } };
    }

    console.log(`\n[ALLOWED] ${cmd}`);
  })
  .on("tool-result", (e) => console.log(`[ok] ${String(e.output).slice(0, 120)}\n`))
  .on("tool-error", (e) => console.log(`[error] ${String(e.error).slice(0, 120)}\n`));

session.send("Try to delete /tmp/test.txt, then find files in /usr, then show the date.");
await session.waitForIdle();
console.log();
