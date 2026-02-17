import { parseProviderSelection } from "./providers";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const startedAt = Date.now();

try {
  const { provider, providerArgs } = parseProviderSelection(process.argv.slice(2));
  const parsedArgs = provider.parseArgs(providerArgs);
  const result = await provider.run(parsedArgs);
  const durationMs = Date.now() - startedAt;

  console.log(
    JSON.stringify(
      {
        provider: provider.name,
        prompt: parsedArgs.prompt,
        timeoutMs: parsedArgs.timeoutMs,
        streamEventsEnabled: parsedArgs.streamEvents,
        durationMs,
        text: result.text,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        warnings: result.warnings,
        finishReason: result.finishReason,
        ...(parsedArgs.streamEvents ? { streamEvents: result.streamEvents ?? [] } : {}),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const durationMs = Date.now() - startedAt;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  console.error(`[bench] failed after ${durationMs}ms: ${message}`);
  process.exitCode = 1;
}
