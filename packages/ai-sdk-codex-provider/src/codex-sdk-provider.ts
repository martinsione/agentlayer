import { NoSuchModelError, type LanguageModelV3, type ProviderV3 } from "@ai-sdk/provider";
import { CodexSdkLanguageModel } from "./codex-sdk-language-model";
import type {
  CodexSdkModelId,
  CodexSdkModelSettings,
  CodexSdkProviderSettings,
} from "./codex-sdk-options";
export type { CodexSdkProviderSettings } from "./codex-sdk-options";

export interface CodexSdkProvider<MODEL_IDS extends string = CodexSdkModelId> extends ProviderV3 {
  (modelId: MODEL_IDS, settings?: CodexSdkModelSettings): LanguageModelV3;
  languageModel(modelId: MODEL_IDS, settings?: CodexSdkModelSettings): LanguageModelV3;
  textEmbeddingModel(modelId: string): never;
}

export function createCodexSdk<MODEL_IDS extends string = CodexSdkModelId>(
  options: CodexSdkProviderSettings = {},
): CodexSdkProvider<MODEL_IDS> {
  const providerId = options.name ?? options.provider ?? "codex-sdk";

  const createLanguageModel = function (
    modelId: MODEL_IDS,
    modelSettings: CodexSdkModelSettings = {},
  ): LanguageModelV3 {
    if (new.target) {
      throw new Error("The Codex SDK model function cannot be called with the new keyword.");
    }

    return new CodexSdkLanguageModel({
      providerId,
      modelId,
      providerSettings: options,
      modelSettings,
    });
  };

  const provider = function (modelId: MODEL_IDS, modelSettings?: CodexSdkModelSettings) {
    return createLanguageModel(modelId, modelSettings);
  };

  provider.specificationVersion = "v3" as const;
  provider.languageModel = createLanguageModel;
  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
  };
  provider.textEmbeddingModel = provider.embeddingModel;
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: "imageModel" });
  };

  return provider as CodexSdkProvider<MODEL_IDS>;
}

export const codexSdk = createCodexSdk();
