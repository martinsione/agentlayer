// Terminal UI chat with streaming and tool calls.
//
// Run: bun examples/tui.ts

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  InputRenderable,
  InputRenderableEvents,
  RenderableEvents,
  SyntaxStyle,
  t,
  bold,
  fg,
} from "@opentui/core";
import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";
import { GlobTool } from "agentlayer/tools/glob";
import { GrepTool } from "agentlayer/tools/grep";
import { ReadTool } from "agentlayer/tools/read";
import { WebFetchTool } from "agentlayer/tools/web-fetch";
import { WriteTool } from "agentlayer/tools/write";

const text = "#e0e0e0";
const muted = "#505050";
const syntaxStyle = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: text } },
  {
    scope: ["markup.heading.1", "markup.heading.2", "markup.heading.3"],
    style: { foreground: text, bold: true },
  },
  { scope: ["markup.raw", "markup.link.url"], style: { foreground: "#808080" } },
  { scope: ["punctuation.special", "markup.list"], style: { foreground: muted } },
]);

// -- Agent --

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-20250514",
  systemPrompt: [
    "You are a coding assistant running in a terminal.",
    "Use tools to answer questions. Be concise.",
    "Prefer glob/grep/read over bash for file exploration.",
    "Use read to examine files before editing. Use write only for new files.",
    "",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toDateString()}`,
  ].join("\n"),
  tools: [BashTool, ReadTool, WriteTool, GlobTool, GrepTool, WebFetchTool],
});

// -- Layout --

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });

const root = new BoxRenderable(renderer, {
  id: "root",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  padding: 1,
  backgroundColor: "#0a0a0a",
});

const scroll = new ScrollBoxRenderable(renderer, {
  id: "scroll",
  flexGrow: 1,
  stickyScroll: true,
  stickyStart: "bottom",
  scrollY: true,
});

const inputBox = new BoxRenderable(renderer, {
  id: "input-box",
  borderStyle: "rounded",
  borderColor: "#282828",
  border: true,
  width: "100%",
  flexShrink: 0,
  marginTop: 1,
});

const input = new InputRenderable(renderer, {
  id: "input",
  placeholder: "Send a message...",
  placeholderColor: muted,
  textColor: text,
  cursorColor: text,
  cursorStyle: { style: "line" },
  width: "100%",
});

inputBox.add(input);
root.add(scroll);
root.add(inputBox);
renderer.root.add(root);

// -- Session --

const session = await agent.createSession();
let md: MarkdownRenderable | null = null;
let buf = "";

session.on("status", (e) => {
  inputBox.borderColor = e.status === "busy" ? "#555" : "#282828";
});

session.on("text-start", () => {
  buf = "";
  md = new MarkdownRenderable(renderer, {
    id: `md-${crypto.randomUUID()}`,
    content: "",
    width: "100%",
    streaming: true,
    syntaxStyle,
  });
  scroll.add(md);
});

session.on("text-delta", (e) => {
  buf += e.text;
  if (md) md.content = buf;
});

session.on("text-end", () => {
  if (md) md.streaming = false;
  md = null;
});

session.on("tool-call", (e) => {
  const args = e.input as Record<string, unknown> | undefined;
  const detail = args?.command ?? args?.url ?? args?.path ?? args?.pattern ?? "";
  scroll.add(
    new TextRenderable(renderer, {
      id: `tc-${e.toolCallId}`,
      content: t`${fg(muted)(`  ↳ ${e.toolName} ${detail}`)}`,
    }),
  );
});

session.on("error", (e) => {
  scroll.add(
    new TextRenderable(renderer, {
      id: `err-${crypto.randomUUID()}`,
      content: t`${fg("#ff8080")(`Error: ${e.error.message}`)}`,
    }),
  );
});

// -- Input --

input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (!value.trim()) return;
  input.value = "";
  scroll.add(
    new TextRenderable(renderer, {
      id: `u-${crypto.randomUUID()}`,
      content: t`${bold(fg(text)(`> ${value}`))}`,
      marginTop: 1,
    }),
  );
  session.send(value);
});

input.focus();
input.on(RenderableEvents.BLURRED, () => input.focus());
renderer.start();
