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

/** Check whether an error represents an abort (typed or DOMException). */
export function isAbortError(err: Error): boolean {
  return err instanceof RuntimeAbortError || err.name === "AbortError";
}

/** Check whether an error represents a timeout (typed or DOMException). */
export function isTimeoutError(err: Error): boolean {
  return err instanceof RuntimeTimeoutError || err.name === "TimeoutError";
}

/**
 * Re-throw an unknown error as a typed RuntimeAbortError or RuntimeTimeoutError
 * if it is a DOMException with name "AbortError" or "TimeoutError". Otherwise
 * re-throw as-is.
 */
export function rethrowAsRuntimeError(err: unknown, timeoutSecs?: number): never {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") throw new RuntimeTimeoutError(timeoutSecs ?? 0);
    if (err.name === "AbortError") throw new RuntimeAbortError();
  }
  throw err;
}
