// Shared console logger for examples.
// Attaches common event listeners for streaming text and tool activity.

import type { Session } from "agentlayer";

export function attachLogger(session: Session): void {
  session.on("text-delta", (e) => void process.stdout.write(e.text));
  session.on("before-tool-call", (e) =>
    console.log(`\n> ${e.toolLabel ?? e.toolName}(${JSON.stringify(e.input)})`),
  );
  session.on("tool-result", (e) => console.log(`[ok] ${String(e.output).slice(0, 120)}`));
  session.on("tool-error", (e) => console.log(`[error] ${String(e.error).slice(0, 120)}`));
}
