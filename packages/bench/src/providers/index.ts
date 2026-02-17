import { claudeAgentProvider } from "./claude-agent";
import { codexProvider } from "./codex";
import type { BenchProvider, ProviderName } from "./types";

const PROVIDERS: Record<ProviderName, BenchProvider> = {
  "claude-agent": claudeAgentProvider,
  codex: codexProvider,
};

function parseProviderName(value: string | undefined): ProviderName | undefined {
  if (value === "claude-agent") {
    return value;
  }

  if (value === "codex") {
    return value;
  }

  return undefined;
}

export function parseProviderSelection(args: string[]): {
  provider: BenchProvider;
  providerArgs: string[];
} {
  let providerName = parseProviderName(process.env.BENCH_PROVIDER) ?? "codex";
  const providerArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--provider") {
      const maybeProviderName = parseProviderName(args[index + 1]);
      if (maybeProviderName == null) {
        throw new Error(`Unsupported provider: ${args[index + 1] ?? "(missing)"}`);
      }
      providerName = maybeProviderName;
      index += 1;
      continue;
    }

    providerArgs.push(arg);
  }

  if (providerArgs.length > 0) {
    const maybeProviderName = parseProviderName(providerArgs[0]);
    if (maybeProviderName != null) {
      providerName = maybeProviderName;
      providerArgs.shift();
    }
  }

  return {
    provider: PROVIDERS[providerName],
    providerArgs,
  };
}
