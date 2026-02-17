import { streamText } from "ai";
import { codexSdk } from "ai-sdk-codex-provider";

const result = streamText({
  model: codexSdk("gpt-5.3-codex"),
  prompt: "Explain what changed in this repo",
});

for await (const part of result.toUIMessageStream()) {
  console.log(JSON.stringify(part, null, 0));
}
