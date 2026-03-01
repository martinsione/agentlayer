import { dirname } from "node:path";
import { Bash } from "just-bash";
import type { IFileSystem } from "just-bash";
import type { Runtime, ExecResult, ExecOptions } from "../types";

export type JustBashRuntimeOptions = {
  cwd?: string;
  fs?: IFileSystem;
  files?: Record<string, string>;
};

export class JustBashRuntime implements Runtime {
  readonly cwd: string;
  private readonly bash: Bash;

  constructor(opts?: JustBashRuntimeOptions) {
    this.cwd = opts?.cwd ?? "/home/user";
    this.bash = new Bash({
      cwd: this.cwd,
      fs: opts?.fs,
      files: opts?.files,
    });
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    let signal = opts?.signal;
    const timeoutSecs = opts?.timeout;
    if (timeoutSecs != null) {
      const timeoutSignal = AbortSignal.timeout(timeoutSecs * 1000);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }

    const execPromise = this.bash.exec(command, {
      cwd: opts?.cwd ?? this.cwd,
    });

    let result: { stdout: string; stderr: string; exitCode: number };

    if (!signal) {
      result = await execPromise;
    } else {
      result = await Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        }),
      ]);
    }

    // Simulate onData with final output (just-bash doesn't support streaming)
    if (opts?.onData) {
      const combined = result.stdout + result.stderr;
      if (combined) opts.onData(Buffer.from(combined, "utf-8"));
    }

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  async readFile(path: string): Promise<string> {
    return this.bash.fs.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.bash.fs.mkdir(dirname(path), { recursive: true });
    await this.bash.fs.writeFile(path, content);
  }
}
