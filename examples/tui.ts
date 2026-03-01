// Minimal TUI showing an agent chat loop with streaming and tool calls.
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
import { WebFetchTool } from "agentlayer/tools/web-fetch";

// -- Agent setup --

const agent = new Agent({
  model: "moonshotai/kimi-k2.5",
  systemPrompt: "You are a helpful assistant. Use tools when needed. Be concise.",
  tools: [BashTool, WebFetchTool],
});

// -- TUI layout --

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
const isDark = renderer.themeMode !== "light";
const syntaxStyle = SyntaxStyle.create();

const root = new BoxRenderable(renderer, {
  id: "root",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  padding: 1,
});

const header = new TextRenderable(renderer, {
  id: "header",
  content: t`${bold(fg(isDark ? "#fff" : "#000")("agentlayer"))} ${fg(isDark ? "#505050" : "#a0a0a0")("tui")}`,
  marginBottom: 1,
});

const scroll = new ScrollBoxRenderable(renderer, {
  id: "scroll",
  flexGrow: 1,
  stickyScroll: true,
  stickyStart: "bottom",
  scrollY: true,
  paddingLeft: 1,
  paddingRight: 1,
});

const inputBox = new BoxRenderable(renderer, {
  id: "input-box",
  borderStyle: "rounded",
  borderColor: isDark ? "#282828" : "#d0d0d0",
  border: true,
  width: "100%",
  marginTop: 1,
});

const input = new InputRenderable(renderer, {
  id: "input",
  placeholder: "Send a message...",
  placeholderColor: isDark ? "#505050" : "#a0a0a0",
  textColor: isDark ? "#fff" : "#101010",
  width: "100%",
});

inputBox.add(input);
root.add(header);
root.add(scroll);
root.add(inputBox);
renderer.root.add(root);

// -- Colors (grayscale, Vercel-themed) --

const userColor = isDark ? "#fff" : "#000";
const toolColor = isDark ? "#a0a0a0" : "#606060";
const errorColor = isDark ? "#ff8080" : "#b30000";

// -- Session --

const session = await agent.createSession();

let md: MarkdownRenderable | null = null;
let buf = "";

// -- Status --

session.on("status", (e) => {
  inputBox.borderColor =
    e.status === "busy" ? (isDark ? "#fff" : "#000") : isDark ? "#282828" : "#d0d0d0";
});

// -- Step boundaries --

session.on("step-start", (e) => {
  if (e.step > 1) {
    scroll.add(
      new TextRenderable(renderer, {
        id: `step-${e.step}`,
        content: t`${fg(toolColor)(`--- step ${e.step} ---`)}`,
      }),
    );
  }
});

// -- Streaming --

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
  const input = e.input as Record<string, unknown> | undefined;
  let label = e.toolName;
  if (e.toolName === "web_fetch" && input?.url) label += ` ${input.url}`;
  if (e.toolName === "bash" && input?.command) label += ` ${input.command}`;
  scroll.add(
    new TextRenderable(renderer, {
      id: `tc-${e.toolCallId}`,
      content: t`${fg(toolColor)(`  ↳ ${label}`)}`,
      marginBottom: 1,
    }),
  );
});

session.on("error", (e) => {
  scroll.add(
    new TextRenderable(renderer, {
      id: `err-${crypto.randomUUID()}`,
      content: t`${fg(errorColor)(`Error: ${e.error.message}`)}`,
      marginBottom: 1,
    }),
  );
});

// -- Input handling --

input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (!value.trim()) return;
  scroll.add(
    new TextRenderable(renderer, {
      id: `u-${crypto.randomUUID()}`,
      content: t`${bold(fg(userColor)(`> ${value}`))}`,
      marginTop: 1,
      marginBottom: 1,
    }),
  );
  input.value = "";
  session.send(value);
});

input.focus();
input.on(RenderableEvents.BLURRED, () => input.focus());
renderer.start();
