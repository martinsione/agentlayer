# AI SDK - Claude Agent SDK Provider

The `@agent-layer/ai-sdk-claude-agent` package provides a Claude Agent SDK-backed provider for the [AI SDK](https://ai-sdk.dev/docs), using [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) under the hood.

## Setup

Install the provider with `ai`:

```bash
npm i @agent-layer/ai-sdk-claude-agent ai
```

## Skill for Coding Agents

If you use coding agents such as Claude Code or Cursor, we recommend adding the AI SDK skill to your repository:

```bash
npx skills add vercel/ai
```

## Provider Instance

Import the default provider instance `claudeAgentSdk`:

```ts
import { claudeAgentSdk } from "@agent-layer/ai-sdk-claude-agent";
```

Or create a customized provider instance:

```ts
import { createClaudeAgentSdk } from "@agent-layer/ai-sdk-claude-agent";

const provider = createClaudeAgentSdk({
  name: "claude-agent-sdk",
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  queryOptions: {
    cwd: process.cwd(),
    permissionMode: "default",
    settingSources: ["project", "local"],
  },
});
```

## Example

```ts
import { claudeAgentSdk } from "@agent-layer/ai-sdk-claude-agent";
import { generateText } from "ai";

const { text } = await generateText({
  model: claudeAgentSdk("default"),
  prompt: "Summarize the repository state in one paragraph.",
});

console.log(text);
```

## Notes

- This provider targets `LanguageModelV3` only.
- AI SDK tools are ignored by the provider because Claude Agent SDK manages tool execution internally.
- Provider-executed tool activity is surfaced through stream events (`tool-call`, `tool-result`) when available from SDK messages.
- Authentication can be supplied via provider settings (`apiKey`, `authToken`) or by pre-configured Claude Agent CLI environment.
- `claudeAgentSdkModelIds` is a non-exhaustive convenience list and may include aliases like `default`, `sonnet`, `haiku`.
- For canonical model IDs used at runtime (for example `claude-opus-4-6`), read `providerMetadata["claude-agent-sdk"].resolvedModelId` / `resolvedModelIds` on results.
- Use runtime discovery for low-maintenance model coverage:

```ts
import { listClaudeAgentSdkModels } from "@agent-layer/ai-sdk-claude-agent";

const models = await listClaudeAgentSdkModels({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log(models.map((model) => model.value));
```

To regenerate the static model id/info files from your current Claude Agent SDK account:

```bash
bun --cwd packages/ai-sdk-claude-agent run sync:model-catalog
```

## Option Coverage

Audited against `@anthropic-ai/claude-agent-sdk@0.2.45`.

- `Options` support: all Claude Agent SDK `Options` fields are supported through the adapter, with four fields mapped from AI SDK primitives instead of direct passthrough:
  - `prompt` comes from AI SDK prompt/messages.
  - `model` comes from the selected model id (`claudeAgentSdk("<model-id>")`).
  - `abortController` comes from AI SDK `abortSignal`.
  - `outputFormat` comes from AI SDK JSON `responseFormat.schema` (mapped to `json_schema`; `responseFormat.name`/`description` map to schema `title`/`description` when missing).
- Pass-through layers for all other Claude `Options` fields:
  - Provider defaults: `createClaudeAgentSdk({ queryOptions: ... })`
  - Model defaults: `claudeAgentSdk(modelId, modelSettings)`
  - Per-call overrides: `providerOptions["<provider-name>"]`
- Provider convenience aliases: `apiKey`, `authToken`, `baseURL`/`baseUrl`, and `env` are merged into Claude process env (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`). If both `baseURL` and `baseUrl` are provided, `baseURL` wins.
- Provider options lookup supports both `providerOptions["claude-agent-sdk"]` (canonical key) and `providerOptions["<provider-name>"]` (custom provider name). If both are present, custom-key values override canonical values.

AI SDK call options currently not forwarded to Claude Agent SDK (warnings emitted):

- `tools`, `toolChoice`
- `headers`
- `temperature`, `topP`, `topK`
- `maxOutputTokens`
- `stopSequences`
- `presencePenalty`, `frequencyPenalty`
- `seed`

## Documentation

- AI SDK community custom provider guide: <https://ai-sdk.dev/providers/community-providers/custom-providers>
- Claude Agent SDK docs: <https://platform.claude.com/docs/en/agent-sdk/overview>
