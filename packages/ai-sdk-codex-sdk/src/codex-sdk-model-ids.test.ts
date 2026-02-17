import { describe, expect, it } from "vitest";
import { codexSdkModelIds } from "./codex-sdk-model-ids";
import { codexSdkModelInfoById } from "./codex-sdk-model-info";

describe("codexSdkModelIds", () => {
  it("is sorted and unique", () => {
    const modelIds = [...codexSdkModelIds];
    const sortedModelIds = [...modelIds].sort((a, b) => a.localeCompare(b));

    expect(modelIds).toEqual(sortedModelIds);
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it("includes the current codex frontier model", () => {
    expect(codexSdkModelIds).toContain("gpt-5.3-codex");
  });

  it("matches the generated model info catalog keys", () => {
    expect(codexSdkModelIds).toEqual(Object.keys(codexSdkModelInfoById).sort());
  });
});
