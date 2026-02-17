import { generateText, streamText } from "ai";
import { createCodexSdk } from "ai-sdk-codex-provider";
import type { BenchProvider, ProviderArgs } from "./types";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

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

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }

  return undefined;
}

function parseApprovalPolicy(value: string | undefined): ApprovalPolicy | undefined {
  if (
    value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
  ) {
    return value;
  }

  return undefined;
}

function createTimeoutError(timeoutMs: number): Error {
  return new Error(
    [
      `Bench timed out after ${timeoutMs}ms.`,
      "Codex likely waited for an approval or stalled process.",
      "Set CODEX_APPROVAL_POLICY=never for non-interactive runs.",
    ].join(" "),
  );
}

type CodexArgs = ProviderArgs;

function parseCodexArgs(args: string[]): CodexArgs {
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
      throw new Error(`Unknown codex bench argument: ${arg}`);
    }

    promptTokens.push(arg);
  }

  return {
    prompt: promptTokens.join(" ").trim() || DEFAULT_PROMPT,
    timeoutMs,
    streamEvents,
  };
}

async function runCodexBench(args: CodexArgs) {
  const codexSdk = createCodexSdk({
    ...(process.env.CODEX_API_KEY != null ? { apiKey: process.env.CODEX_API_KEY } : {}),
    ...(process.env.CODEX_BASE_URL != null
      ? { baseUrl: process.env.CODEX_BASE_URL }
      : process.env.OPENAI_BASE_URL != null
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
    ...(process.env.CODEX_PATH_OVERRIDE != null
      ? { codexPathOverride: process.env.CODEX_PATH_OVERRIDE }
      : {}),
    threadOptions: {
      workingDirectory: process.cwd(),
      sandboxMode: parseSandboxMode(process.env.CODEX_SANDBOX_MODE) ?? "read-only",
      approvalPolicy: parseApprovalPolicy(process.env.CODEX_APPROVAL_POLICY) ?? "never",
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
        model: codexSdk(process.env.CODEX_MODEL ?? "gpt-5"),
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
      model: codexSdk(process.env.CODEX_MODEL ?? "gpt-5"),
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

export const codexProvider: BenchProvider<CodexArgs> = {
  name: "codex",
  parseArgs: parseCodexArgs,
  run: runCodexBench,
};
