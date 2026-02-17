import { NoSuchModelError, type LanguageModelV3, type ProviderV3 } from "@ai-sdk/provider";
import { ClaudeAgentSdkLanguageModel } from "./claude-agent-sdk-language-model";
import type {
  ClaudeAgentSdkModelId,
  ClaudeAgentSdkModelSettings,
  ClaudeAgentSdkProviderSettings,
} from "./claude-agent-sdk-options";

export type { ClaudeAgentSdkProviderSettings } from "./claude-agent-sdk-options";

export interface ClaudeAgentSdkProvider<
  MODEL_IDS extends string = ClaudeAgentSdkModelId,
> extends ProviderV3 {
  (modelId: MODEL_IDS, settings?: ClaudeAgentSdkModelSettings): LanguageModelV3;
  languageModel(modelId: MODEL_IDS, settings?: ClaudeAgentSdkModelSettings): LanguageModelV3;
  agent(modelId: MODEL_IDS, settings?: ClaudeAgentSdkModelSettings): LanguageModelV3;
}

export function createClaudeAgentSdk<MODEL_IDS extends string = ClaudeAgentSdkModelId>(
  options: ClaudeAgentSdkProviderSettings = {},
): ClaudeAgentSdkProvider<MODEL_IDS> {
  const providerId = options.name ?? options.provider ?? "claude-agent-sdk";

  const createLanguageModel = function (
    modelId: MODEL_IDS,
    modelSettings: ClaudeAgentSdkModelSettings = {},
  ): LanguageModelV3 {
    if (new.target) {
      throw new Error("The Claude Agent SDK model function cannot be called with the new keyword.");
    }

    return new ClaudeAgentSdkLanguageModel({
      providerId,
      modelId,
      providerSettings: options,
      modelSettings,
    });
  };

  const provider = function (modelId: MODEL_IDS, settings?: ClaudeAgentSdkModelSettings) {
    return createLanguageModel(modelId, settings);
  };

  provider.specificationVersion = "v3" as const;
  provider.languageModel = createLanguageModel;
  provider.agent = createLanguageModel;
  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
  };
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" });
  };

  return provider as ClaudeAgentSdkProvider<MODEL_IDS>;
}

export const claudeAgentSdk = createClaudeAgentSdk();
