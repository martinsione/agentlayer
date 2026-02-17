import { describe, expect, it } from "vitest";
import { claudeAgentSdkModelIds } from "./claude-agent-sdk-model-ids";

describe("claudeAgentSdkModelIds", () => {
  it("contains at least one generated model id", () => {
    expect(claudeAgentSdkModelIds.length).toBeGreaterThan(0);
    expect(claudeAgentSdkModelIds.every((modelId) => modelId.length > 0)).toBe(true);
  });
});
