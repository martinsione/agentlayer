import {
  query,
  type ModelInfo,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentSdkProviderSettings } from "./claude-agent-sdk-options";

export type ClaudeAgentSdkSupportedModel = ModelInfo;

/**
 * Query Claude Agent SDK for the account-specific supported model list.
 *
 * This avoids maintaining static model ids in this package.
 */
export async function listClaudeAgentSdkModels(
  providerSettings: ClaudeAgentSdkProviderSettings = {},
): Promise<ClaudeAgentSdkSupportedModel[]> {
  const run = query({
    prompt: emptyPromptStream(),
    options: makeModelCatalogQueryOptions(providerSettings),
  });

  try {
    return await run.supportedModels();
  } finally {
    safeCloseQuery(run);
  }
}

function makeModelCatalogQueryOptions(providerSettings: ClaudeAgentSdkProviderSettings): Options {
  const env = resolveEnv(
    providerSettings,
    providerSettings.queryOptions?.env as Options["env"] | undefined,
  );

  return {
    ...(providerSettings.queryOptions ?? {}),
    ...(env != null ? { env } : {}),
  } as Options;
}

async function* emptyPromptStream(): AsyncGenerator<SDKUserMessage, void, void> {}

function resolveEnv(
  providerSettings: ClaudeAgentSdkProviderSettings,
  overrideEnv: Options["env"] | undefined,
): Options["env"] | undefined {
  const env: Record<string, string | undefined> = {
    ...(providerSettings.env ?? {}),
    ...(overrideEnv ?? {}),
  };

  if (providerSettings.apiKey != null && env.ANTHROPIC_API_KEY == null) {
    env.ANTHROPIC_API_KEY = providerSettings.apiKey;
  }

  if (providerSettings.authToken != null && env.ANTHROPIC_AUTH_TOKEN == null) {
    env.ANTHROPIC_AUTH_TOKEN = providerSettings.authToken;
  }

  const baseURL = providerSettings.baseURL ?? providerSettings.baseUrl;
  if (baseURL != null && env.ANTHROPIC_BASE_URL == null) {
    env.ANTHROPIC_BASE_URL = baseURL;
  }

  if (Object.keys(env).length === 0) {
    return undefined;
  }

  return env;
}

function safeCloseQuery(run: ReturnType<typeof query>): void {
  try {
    run.close();
  } catch {
    // ignore close errors during cleanup
  }
}
