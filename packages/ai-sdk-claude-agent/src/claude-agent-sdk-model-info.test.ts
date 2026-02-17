import { describe, expect, it } from "vitest";
import {
  claudeAgentSdkModelInfoById,
  getClaudeAgentSdkModelInfo,
} from "./claude-agent-sdk-model-info";

describe("claudeAgentSdkModelInfo", () => {
  it("contains generated entries", () => {
    expect(Object.keys(claudeAgentSdkModelInfoById).length).toBeGreaterThan(0);
  });

  it("returns exact model info for known model ids", () => {
    const knownModelId = Object.keys(claudeAgentSdkModelInfoById)[0];
    expect(knownModelId).toBeDefined();
    if (knownModelId == null) {
      return;
    }

    expect(getClaudeAgentSdkModelInfo(knownModelId)).toEqual(
      claudeAgentSdkModelInfoById[knownModelId as keyof typeof claudeAgentSdkModelInfoById],
    );
  });

  it("matches model variants by prefix", () => {
    const knownModelId = Object.keys(claudeAgentSdkModelInfoById)[0];
    expect(knownModelId).toBeDefined();
    if (knownModelId == null) {
      return;
    }

    expect(getClaudeAgentSdkModelInfo(`${knownModelId}-variant`)).toEqual(
      claudeAgentSdkModelInfoById[knownModelId as keyof typeof claudeAgentSdkModelInfoById],
    );
  });

  it("returns undefined for unknown models", () => {
    expect(getClaudeAgentSdkModelInfo("claude-unknown-model")).toBeUndefined();
  });
});
