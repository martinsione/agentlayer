import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
export type { CodexSdkModelId } from "./codex-sdk-model-ids";

export interface CodexSdkProviderSettings {
  apiKey?: CodexOptions["apiKey"];
  /**
   * Base URL for the Codex backend.
   */
  baseURL?: CodexOptions["baseUrl"];

  /**
   * @deprecated Use `baseURL` instead.
   */
  baseUrl?: CodexOptions["baseUrl"];

  codexPathOverride?: CodexOptions["codexPathOverride"];
  env?: CodexOptions["env"];
  config?: CodexOptions["config"];
  threadOptions?: ThreadOptions;

  /**
   * Provider name used in AI SDK provider metadata and providerOptions lookup.
   */
  name?: string;

  /**
   * @deprecated Use `name` instead.
   */
  provider?: string;
}

export interface CodexSdkModelSettings extends Partial<ThreadOptions> {}

export interface CodexSdkCallSettings extends Partial<ThreadOptions> {
  threadId?: string;
}
