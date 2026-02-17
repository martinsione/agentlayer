import { generateText, streamText } from "ai";
import { createClaudeAgentSdk } from "ai-sdk-claude-agent-provider";
import type { ClaudeAgentSdkModelSettings } from "ai-sdk-claude-agent-provider";
import type { BenchProvider, ProviderArgs } from "./types";

type PermissionMode = NonNullable<ClaudeAgentSdkModelSettings["permissionMode"]>;
type SettingSource = "user" | "project" | "local";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT = "Summarize the current repository status in one short paragraph.";

function parseTimeoutValue(value: string | undefined, source: string): number {
  if (value == null || value.length === 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout in ${source}: ${value}. Expected a positive integer.`);
  }

  return parsed;
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "delegate" ||
    value === "dontAsk"
  ) {
    return value;
  }

  return undefined;
}

function parseSettingSources(value: string | undefined): SettingSource[] | undefined {
  if (value == null || value.trim().length === 0) {
    return undefined;
  }

  const parsed: SettingSource[] = [];
  for (const source of value.split(",")) {
    const candidate = source.trim();
    if (candidate === "user" || candidate === "project" || candidate === "local") {
      parsed.push(candidate);
      continue;
    }

    throw new Error(
      `Invalid CLAUDE_AGENT_SETTING_SOURCES value: ${candidate}. Expected comma-separated user,project,local.`,
    );
  }

  return parsed.length > 0 ? parsed : undefined;
}

function createTimeoutError(timeoutMs: number): Error {
  return new Error(
    [
      `Bench timed out after ${timeoutMs}ms.`,
      "Claude Agent likely waited for a permission decision or stalled process.",
      "Try CLAUDE_AGENT_PERMISSION_MODE=acceptEdits for non-interactive runs.",
    ].join(" "),
  );
}

type ClaudeAgentArgs = ProviderArgs;

function parseClaudeAgentArgs(args: string[]): ClaudeAgentArgs {
  let timeoutMs = parseTimeoutValue(process.env.BENCH_TIMEOUT_MS, "BENCH_TIMEOUT_MS");
  let streamEvents = process.env.BENCH_STREAM_EVENTS === "1";
  const promptTokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = parseTimeoutValue(args[index + 1], "--timeout-ms");
      index += 1;
      continue;
    }

    if (arg === "--stream-events") {
      streamEvents = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown claude-agent bench argument: ${arg}`);
    }

    promptTokens.push(arg);
  }

  return {
    prompt: promptTokens.join(" ").trim() || DEFAULT_PROMPT,
    timeoutMs,
    streamEvents,
  };
}

async function runClaudeAgentBench(args: ClaudeAgentArgs) {
  const permissionMode = parsePermissionMode(process.env.CLAUDE_AGENT_PERMISSION_MODE);
  const settingSources = parseSettingSources(process.env.CLAUDE_AGENT_SETTING_SOURCES) ?? [
    "project",
    "local",
  ];

  const claudeAgentSdk = createClaudeAgentSdk({
    ...(process.env.ANTHROPIC_API_KEY != null ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.ANTHROPIC_AUTH_TOKEN != null
      ? { authToken: process.env.ANTHROPIC_AUTH_TOKEN }
      : {}),
    ...(process.env.ANTHROPIC_BASE_URL != null ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    queryOptions: {
      cwd: process.cwd(),
      ...(permissionMode != null ? { permissionMode } : {}),
      ...(settingSources.length > 0 ? { settingSources } : {}),
      ...(process.env.CLAUDE_AGENT_PATH_TO_EXECUTABLE != null
        ? { pathToClaudeCodeExecutable: process.env.CLAUDE_AGENT_PATH_TO_EXECUTABLE }
        : {}),
      ...(process.env.CLAUDE_AGENT_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS === "1"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
    },
  });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort(createTimeoutError(args.timeoutMs));
  }, args.timeoutMs);
  timeoutId.unref?.();

  try {
    if (!args.streamEvents) {
      const result = await generateText({
        model: claudeAgentSdk(process.env.CLAUDE_AGENT_MODEL ?? "default"),
        prompt: args.prompt,
        abortSignal: abortController.signal,
      });

      return {
        text: result.text,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        warnings: result.warnings,
        finishReason: result.finishReason,
      };
    }

    const result = streamText({
      model: claudeAgentSdk(process.env.CLAUDE_AGENT_MODEL ?? "default"),
      prompt: args.prompt,
      abortSignal: abortController.signal,
    });

    const events: unknown[] = [];
    for await (const part of result.fullStream) {
      if (
        part.type === "tool-call" ||
        part.type === "tool-result" ||
        part.type === "tool-error" ||
        part.type === "tool-input-start" ||
        part.type === "tool-input-delta" ||
        part.type === "tool-input-end"
      ) {
        events.push(part);
      }
    }

    return {
      text: await result.text,
      usage: await result.totalUsage,
      providerMetadata: await result.providerMetadata,
      warnings: await result.warnings,
      finishReason: await result.finishReason,
      streamEvents: events,
    };
  } catch (error) {
    if (abortController.signal.aborted) {
      throw createTimeoutError(args.timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const claudeAgentProvider: BenchProvider<ClaudeAgentArgs> = {
  name: "claude-agent",
  parseArgs: parseClaudeAgentArgs,
  run: runClaudeAgentBench,
};
