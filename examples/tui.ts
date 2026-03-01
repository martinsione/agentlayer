// Minimal TUI showing an agent chat loop with streaming and tool calls.
//
// Run:          bun examples/tui.ts
// Force light:  THEME=light bun examples/tui.ts

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
  KeyEvent,
  t,
  bold,
  fg,
} from "@opentui/core";
import { Agent } from "agentlayer";
import { BashTool } from "agentlayer/tools/bash";
import { WebFetchTool } from "agentlayer/tools/web-fetch";
import type { SendMode } from "agentlayer/types";

// -- Agent setup --

const agent = new Agent({
  // model: "moonshotai/kimi-k2.5",
  model: "openai/gpt-oss-120b",
  systemPrompt: `You are a helpful assistant. Use tools when needed. Be concise. The current date is ${new Date().toISOString().slice(0, 10)}. Always use this date for any time-sensitive queries.`,
  tools: [BashTool, WebFetchTool],
});

// -- TUI layout --

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });

// renderer.themeMode is null until the terminal responds to the OSC query.
// Wait briefly for the async response before falling back.
await Promise.race([
  new Promise<void>((r) => renderer.on("theme_mode", () => r())),
  new Promise<void>((r) => setTimeout(r, 150)),
]);

// COLORFGBG ("fg;bg") works inside tmux where OSC queries may fail.
// THEME=light/dark is a manual escape hatch.
function detectDark(): boolean {
  const env = process.env.THEME?.toLowerCase();
  if (env === "light") return false;
  if (env === "dark") return true;
  const bg = parseInt(process.env.COLORFGBG?.split(";").pop() ?? "", 10);
  if (!isNaN(bg)) return bg < 7;
  return renderer.themeMode !== "light";
}

const dark = detectDark();

// opentui defaults all foreground text to #fff, so every element needs an
// explicit color — we can't rely on "terminal native" foreground.
const theme = dark
  ? {
      text: "#e0e0e0",
      muted: "#505050",
      border: "#282828",
      borderActive: "#555",
      placeholder: "#505050",
      tool: "#a0a0a0",
      error: "#ff8080",
    }
  : {
      text: "#000",
      muted: "#777",
      border: "#bbb",
      borderActive: "#666",
      placeholder: "#777",
      tool: "#555",
      error: "#b30000",
    };

// SyntaxStyle.create() registers zero styles — MarkdownRenderable text falls
// back to opentui's hardcoded #fff. Register "default" so body text is visible.
const syntaxStyle = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: theme.text } },
  {
    scope: ["markup.heading.1", "markup.heading.2", "markup.heading.3"],
    style: { foreground: theme.text, bold: true },
  },
  { scope: ["markup.raw"], style: { foreground: dark ? "#a0a0a0" : "#555" } },
  { scope: ["markup.link.url"], style: { foreground: dark ? "#808080" : "#555" } },
  { scope: ["punctuation.special", "markup.list"], style: { foreground: theme.muted } },
]);

const root = new BoxRenderable(renderer, {
  id: "root",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  padding: 1,
});

const header = new TextRenderable(renderer, {
  id: "header",
  content: t`${bold(fg(theme.text)("agentlayer"))} ${fg(theme.muted)("tui")}`,
  marginBottom: 1,
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
  borderColor: theme.border,
  border: true,
  width: "100%",
  flexShrink: 0,
  marginTop: 1,
});

const input = new InputRenderable(renderer, {
  id: "input",
  placeholder: "Send a message...",
  placeholderColor: theme.placeholder,
  textColor: theme.text,
  cursorColor: theme.text,
  cursorStyle: { style: "line" },
  width: "100%",
});

let sendMode: SendMode = "steer";

function modeLabelContent() {
  return t`${fg(theme.text)(sendMode)} ${fg(theme.muted)("(shift+tab to cycle)")}`;
}

const modeLabel = new TextRenderable(renderer, {
  id: "mode-label",
  content: modeLabelContent(),
  flexShrink: 0,
});

const queueArea = new BoxRenderable(renderer, {
  id: "queue-area",
  flexDirection: "column",
  width: "100%",
  flexShrink: 0,
});

inputBox.add(input);
root.add(header);
root.add(scroll);
root.add(queueArea);
root.add(inputBox);
root.add(modeLabel);
renderer.root.add(root);

const session = await agent.createSession();

let md: MarkdownRenderable | null = null;
let buf = "";
let thinking: TextRenderable | null = null;
const pendingQueue: { text: string; id: string }[] = [];

function showThinking() {
  if (thinking) return;
  thinking = new TextRenderable(renderer, {
    id: `thinking-${crypto.randomUUID()}`,
    content: t`${fg(theme.muted)("thinking...")}`,
  });
  scroll.add(thinking);
}

function hideThinking() {
  if (!thinking) return;
  scroll.remove(thinking.id);
  thinking = null;
}

session.on("status", (e) => {
  inputBox.borderColor = e.status === "busy" ? theme.borderActive : theme.border;
  if (e.status === "busy") showThinking();
  if (e.status === "idle") hideThinking();
});

session.on("text-start", () => {
  hideThinking();
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
      content: t`${fg(theme.tool)(`  ↳ ${label}`)}`,
    }),
  );
});

session.on("error", (e) => {
  scroll.add(
    new TextRenderable(renderer, {
      id: `err-${crypto.randomUUID()}`,
      content: t`${fg(theme.error)(`Error: ${e.error.message}`)}`,
    }),
  );
});

// Promote queued messages to scroll when the session processes them.
session.on("message", (e) => {
  if (e.message.role !== "user" || pendingQueue.length === 0) return;
  const entry = pendingQueue.shift()!;
  queueArea.remove(entry.id);
  scroll.add(
    new TextRenderable(renderer, {
      id: `u-${crypto.randomUUID()}`,
      content: t`${bold(fg(theme.text)(`> ${entry.text}`))}`,
      marginTop: 1,
    }),
  );
});

input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (!value.trim()) return;
  input.value = "";

  if (session.status === "busy" && sendMode === "queue") {
    // Show as pending above input, promote when processed.
    const id = `q-${crypto.randomUUID()}`;
    pendingQueue.push({ text: value, id });
    queueArea.add(
      new TextRenderable(renderer, {
        id,
        content: t`${fg(theme.muted)(`> ${value}`)}`,
      }),
    );
  } else {
    scroll.add(
      new TextRenderable(renderer, {
        id: `u-${crypto.randomUUID()}`,
        content: t`${bold(fg(theme.text)(`> ${value}`))}`,
        marginTop: 1,
      }),
    );
  }

  session.send(value, { mode: sendMode });
});

input.onKeyDown = (key: KeyEvent) => {
  if (key.name === "tab" && key.shift) {
    sendMode = sendMode === "steer" ? "queue" : "steer";
    modeLabel.content = modeLabelContent();
  }
};

input.focus();
input.on(RenderableEvents.BLURRED, () => input.focus());
renderer.start();
