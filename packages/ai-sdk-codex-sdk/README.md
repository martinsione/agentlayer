# AI SDK - Codex SDK Provider

The `@agent-layer/ai-sdk-codex-sdk` package provides a Codex SDK-backed provider for the [AI SDK](https://ai-sdk.dev/docs), using [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) under the hood.

## Setup

Install the provider with `ai`:

```bash
npm i @agent-layer/ai-sdk-codex-sdk ai
```

## Skill for Coding Agents

If you use coding agents such as Claude Code or Cursor, we recommend adding the AI SDK skill to your repository:

```bash
npx skills add vercel/ai
```

## Provider Instance

You can import the default provider instance `codexSdk`:

```ts
import { codexSdk } from "@agent-layer/ai-sdk-codex-sdk";
```

Or create a customized provider instance:

```ts
import { createCodexSdk } from "@agent-layer/ai-sdk-codex-sdk";

const provider = createCodexSdk({
  name: "codex-sdk",
  baseURL: process.env.OPENAI_BASE_URL,
  threadOptions: {
    workingDirectory: process.cwd(),
    sandboxMode: "read-only",
    approvalPolicy: "never",
  },
});
```

## Example

```ts
import { codexSdk } from "@agent-layer/ai-sdk-codex-sdk";
import { generateText } from "ai";

const { text } = await generateText({
  model: codexSdk("gpt-5"),
  prompt: "Summarize the repository state in one paragraph.",
});

console.log(text);
```

## Including Model IDs for Auto-Completion

```ts
import { createCodexSdk } from "@agent-layer/ai-sdk-codex-sdk";

type CodexModelIds = "gpt-5.3-codex" | "gpt-5.2-codex" | (string & {});

const provider = createCodexSdk<CodexModelIds>();

provider("gpt-5.3-codex");
```

To refresh the generated model catalog (model ids + metadata) from upstream Codex:

```bash
bun --cwd packages/ai-sdk-codex-sdk run sync:model-catalog
```

Read generated model metadata at runtime:

```ts
import { getCodexSdkModelInfo } from "@agent-layer/ai-sdk-codex-sdk";

const info = getCodexSdkModelInfo("gpt-5.3-codex");
console.log(info?.contextWindow);
```

## Notes

- This provider targets `LanguageModelV3` only.
- AI SDK tools are ignored by the provider because Codex executes tools autonomously.
- Provider-executed Codex tools are surfaced through stream events (`tool-call`, `tool-result`).
- Set `includeRawChunks: true` in AI SDK call options to receive raw Codex `ThreadEvent` payloads in the stream.
- Codex SDK authentication (ChatGPT account or API key) must already be configured in your environment.

## Option Coverage

Audited against `@openai/codex-sdk@0.101.0`.

- `CodexOptions` support: `createCodexSdk(...)` forwards all current `CodexOptions` fields. `baseUrl` is supported via `baseURL` (preferred) and `baseUrl` (deprecated alias).
- `ThreadOptions` support: supported at all adapter layers:
  - Provider default: `createCodexSdk({ threadOptions: ... })`
  - Model default: `codexSdk(modelId, modelSettings)`
  - Per-call override: `providerOptions["<provider-name>"]`
- Resume support: `providerOptions["<provider-name>"].threadId` maps to `codex.resumeThread(threadId, threadOptions)`.
- Turn options support: AI SDK `abortSignal` maps to Codex `TurnOptions.signal`; AI SDK JSON response schema maps to Codex `TurnOptions.outputSchema` (`responseFormat.name`/`description` are mapped to schema `title`/`description` when missing).

Not fully passthrough:

- `ThreadOptions.model` is intentionally overridden by the AI SDK model id (`codexSdk("<model-id>")`) on every call.

AI SDK call options currently not forwarded to Codex (warnings emitted):

- `tools`, `toolChoice`
- `headers`
- `temperature`, `topP`, `topK`
- `maxOutputTokens`
- `stopSequences`
- `presencePenalty`, `frequencyPenalty`
- `seed`

## Documentation

- AI SDK community custom provider guide: <https://ai-sdk.dev/providers/community-providers/custom-providers>
- Codex SDK docs: <https://github.com/openai/codex/tree/main/sdk/typescript>
