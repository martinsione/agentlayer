import { describe, expect, it } from "vitest";
import { codexSdkModelInfoById, getCodexSdkModelInfo } from "./codex-sdk-model-info";

describe("codexSdkModelInfoById", () => {
  it("contains entries keyed by model id", () => {
    expect(codexSdkModelInfoById["gpt-5.3-codex"]).toBeDefined();
    expect(codexSdkModelInfoById["gpt-5.3-codex"]?.contextWindow).toBe(272000);
  });

  it("resolves exact ids and longest-prefix ids", () => {
    expect(getCodexSdkModelInfo("gpt-5.3-codex")?.modelId).toBe("gpt-5.3-codex");
    expect(getCodexSdkModelInfo("gpt-5.3-codex-preview")?.modelId).toBe("gpt-5.3-codex");
  });

  it("returns undefined for unknown model ids", () => {
    expect(getCodexSdkModelInfo("unknown-model")).toBeUndefined();
  });
});
