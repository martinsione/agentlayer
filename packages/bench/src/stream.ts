import { codexSdk } from "@agent-layer/ai-sdk-codex-sdk";
import { streamText } from "ai";

const result = streamText({
  model: codexSdk("gpt-5.3-codex"),
  prompt: "Explain what changed in this repo",
});

for await (const part of result.toUIMessageStream()) {
  console.log(JSON.stringify(part, null, 0));
}
