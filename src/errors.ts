export class RuntimeAbortError extends Error {
  readonly code = "ABORT" as const;
  constructor(message?: string) {
    super(message ?? "Operation aborted");
    this.name = "RuntimeAbortError";
  }
}

export class RuntimeTimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
  readonly timeoutSecs: number;
  constructor(timeoutSecs: number, message?: string) {
    super(message ?? `Operation timed out after ${timeoutSecs}s`);
    this.name = "RuntimeTimeoutError";
    this.timeoutSecs = timeoutSecs;
  }
}
