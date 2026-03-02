import type { Sandbox } from "@vercel/sandbox";
import { rethrowAsRuntimeError } from "../errors";
import type { Runtime, ExecResult, ExecOptions } from "../types";

export type SandboxRuntimeOptions = {
  sandbox: Sandbox;
  cwd?: string;
};

export class VercelSandboxRuntime implements Runtime {
  readonly cwd: string;
  private readonly sandbox: Sandbox;

  constructor(opts: SandboxRuntimeOptions) {
    this.sandbox = opts.sandbox;
    this.cwd = opts.cwd ?? "/vercel/sandbox";
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    let signal = opts?.signal;
    if (opts?.timeout != null) {
      const timeoutSignal = AbortSignal.timeout(opts.timeout * 1000);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }

    try {
      const result = await this.sandbox.runCommand({
        cmd: "sh",
        args: ["-c", command],
        cwd: opts?.cwd ?? this.cwd,
        signal,
      });

      const stdout = await result.stdout();
      const stderr = await result.stderr();

      // Simulate onData with final output (sandbox doesn't support streaming)
      if (opts?.onData) {
        const combined = stdout + stderr;
        if (combined) opts.onData(Buffer.from(combined, "utf-8"));
      }

      return { stdout, stderr, exitCode: result.exitCode };
    } catch (err) {
      rethrowAsRuntimeError(err, opts?.timeout);
    }
  }

  async readFile(path: string): Promise<string> {
    const buf = await this.sandbox.readFileToBuffer({ path });
    if (!buf) {
      throw new Error(`File not found: ${path}`);
    }
    return buf.toString("utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.writeFiles([{ path, content: Buffer.from(content, "utf-8") }]);
  }
}
