import type { Sandbox } from "@vercel/sandbox";
import type { Runtime, ExecResult } from "../types";

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

  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    let signal = opts?.signal;
    if (opts?.timeout != null) {
      const timeoutSignal = AbortSignal.timeout(opts.timeout);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }

    const result = await this.sandbox.runCommand({
      cmd: "sh",
      args: ["-c", command],
      cwd: opts?.cwd ?? this.cwd,
      signal,
    });

    const stdout = await result.stdout();
    const stderr = await result.stderr();
    return { stdout, stderr, exitCode: result.exitCode };
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
