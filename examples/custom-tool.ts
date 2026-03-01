// Create typed tools with defineTool and compose them in an agent.
//
// The zod schema gives you type-safe input in the execute callback
// and is auto-converted to JSON Schema for the model.
//
// Run: npx tsx examples/custom-tool.ts

import { Agent } from "agentlayer";
import { defineTool } from "agentlayer/define-tool";
import { z } from "zod";

const readFile = defineTool({
  name: "read_file",
  description: "Read a file and return its contents",
  schema: z.object({
    path: z.string().describe("Absolute file path"),
  }),
  execute: async (input, ctx) => ctx.runtime.readFile(input.path),
});

const writeFile = defineTool({
  name: "write_file",
  description: "Write content to a file",
  schema: z.object({
    path: z.string().describe("Absolute file path"),
    content: z.string().describe("Content to write"),
  }),
  execute: async (input, ctx) => {
    await ctx.runtime.writeFile(input.path, input.content);
    return `Wrote ${input.content.length} bytes to ${input.path}`;
  },
});

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [readFile, writeFile],
});

const session = await agent.createSession();

session
  .on("text-delta", (e) => void process.stdout.write(e.text))
  .on("before-tool-call", (e) => console.log(`\n> ${e.toolName}(${JSON.stringify(e.input)})`))
  .on("tool-result", (e) => console.log(`[ok] ${e.output}\n`))
  .on("tool-error", (e) => console.log(`[error] ${e.error}\n`));

session.send("Write a haiku to /tmp/haiku.txt, then read it back to me.");
await session.waitForIdle();
console.log();
