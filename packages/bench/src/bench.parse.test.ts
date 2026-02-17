import { describe, expect, it } from "bun:test";
import { parseProviderSelection } from "./providers";

describe("bench provider selection", () => {
  it("defaults to codex", () => {
    const { provider, providerArgs } = parseProviderSelection(["hello", "world"]);
    expect(provider.name).toBe("codex");
    expect(providerArgs).toEqual(["hello", "world"]);
  });

  it("supports --provider claude-agent", () => {
    const { provider, providerArgs } = parseProviderSelection([
      "--provider",
      "claude-agent",
      "hello",
      "world",
    ]);
    expect(provider.name).toBe("claude-agent");
    expect(providerArgs).toEqual(["hello", "world"]);
  });

  it("supports --provider codex", () => {
    const { provider, providerArgs } = parseProviderSelection([
      "--provider",
      "codex",
      "hello",
      "world",
    ]);
    expect(provider.name).toBe("codex");
    expect(providerArgs).toEqual(["hello", "world"]);
  });

  it("supports provider as first positional token", () => {
    const { provider, providerArgs } = parseProviderSelection(["codex", "hello", "world"]);
    expect(provider.name).toBe("codex");
    expect(providerArgs).toEqual(["hello", "world"]);
  });

  it("supports claude-agent as first positional token", () => {
    const { provider, providerArgs } = parseProviderSelection(["claude-agent", "hello", "world"]);
    expect(provider.name).toBe("claude-agent");
    expect(providerArgs).toEqual(["hello", "world"]);
  });

  it("throws for unsupported provider", () => {
    expect(() => parseProviderSelection(["--provider", "nope"])).toThrow("Unsupported provider");
  });
});
