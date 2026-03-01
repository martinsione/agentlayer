import { dirname } from "node:path";
import { Bash } from "just-bash";
import type { IFileSystem } from "just-bash";
import type { Runtime, ExecResult } from "../types";

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

  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    let signal = opts?.signal;
    if (opts?.timeout != null) {
      const timeoutSignal = AbortSignal.timeout(opts.timeout);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }

    const execPromise = this.bash.exec(command, {
      cwd: opts?.cwd ?? this.cwd,
    });

    if (!signal) {
      const result = await execPromise;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }

    const result = await Promise.race([
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
