export type ProviderName = "codex";

export type BenchRunResult = {
  text: string;
  usage: unknown;
  providerMetadata: unknown;
  warnings: unknown;
  finishReason: unknown;
  streamEvents?: unknown[];
};

export type ProviderArgs = {
  prompt: string;
  timeoutMs: number;
  streamEvents: boolean;
};

export interface BenchProvider<Args extends ProviderArgs = ProviderArgs> {
  readonly name: ProviderName;
  parseArgs(args: string[]): Args;
  run(args: Args): Promise<BenchRunResult>;
}
