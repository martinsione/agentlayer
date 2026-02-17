import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type { ClaudeAgentSdkModelId } from "./claude-agent-sdk-model-ids";

type ClaudeAgentQueryOptions = Omit<
  Options,
  "prompt" | "model" | "abortController" | "outputFormat"
>;

export interface ClaudeAgentSdkProviderSettings {
  /**
   * API key passed to the Claude Agent process via `ANTHROPIC_API_KEY`.
   */
  apiKey?: string;

  /**
   * Auth token passed via `ANTHROPIC_AUTH_TOKEN`.
   */
  authToken?: string;

  /**
   * Base URL passed via `ANTHROPIC_BASE_URL`.
   */
  baseURL?: string;

  /**
   * @deprecated Use `baseURL` instead.
   */
  baseUrl?: string;

  /**
   * Base environment for every query.
   */
  env?: Options["env"];

  /**
   * Default query options applied to all model calls.
   */
  queryOptions?: Partial<ClaudeAgentQueryOptions>;

  /**
   * Provider name used in AI SDK provider metadata and providerOptions lookup.
   */
  name?: string;

  /**
   * @deprecated Use `name` instead.
   */
  provider?: string;
}

export interface ClaudeAgentSdkModelSettings extends Partial<ClaudeAgentQueryOptions> {}

export interface ClaudeAgentSdkCallSettings extends Partial<ClaudeAgentQueryOptions> {}
