/**
 * Bash tool — execute shell commands with output truncation, timeout, and abort support.
 *
 * Delegates process execution to `ctx.runtime.exec()`.
 * Output truncation and temp-file spillover are handled at the tool level.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, unlink } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type { Tool, ToolContext } from "../types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bashSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  timeout: z.number().optional().describe("Timeout in seconds"),
});

export type BashToolInput = z.infer<typeof bashSchema>;

export interface BashToolOptions {
  /** Command prefix prepended to every command (e.g. "shopt -s expand_aliases"). */
  commandPrefix?: string;
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/** Check whether an error represents an abort (custom format or standard AbortError). */
function isAbortError(err: Error): boolean {
  // Custom format from runtime: "aborted"
  if (err.message === "aborted") return true;
  // Standard DOMException from AbortSignal (used by VercelSandboxRuntime, JustBashRuntime, etc.)
  if (err.name === "AbortError") return true;
  return false;
}

/** Check whether an error represents a timeout (custom format or standard TimeoutError). */
function isTimeoutError(err: Error): boolean {
  // Custom format from runtime: "timeout:<seconds>"
  if (err.message.startsWith("timeout:")) return true;
  // Standard DOMException from AbortSignal.timeout()
  if (err.name === "TimeoutError") return true;
  return false;
}

/** Extract timeout seconds from either the custom "timeout:<s>" format or the input value. */
function extractTimeoutSecs(err: Error, inputTimeout?: number): string {
  if (err.message.startsWith("timeout:")) {
    return err.message.split(":")[1];
  }
  // For standard TimeoutError, fall back to the user-supplied timeout value
  return inputTimeout != null ? String(inputTimeout) : "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `agentlayer-bash-${id}.log`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a bash tool bound to a specific working directory.
 *
 * Delegates execution to `ctx.runtime.exec()` with streaming output via `onData`.
 * Output is tail-truncated; if truncated, full output is saved to a temp file.
 */
export function createBashTool(cwd?: string, options?: BashToolOptions): Tool {
  const commandPrefix = options?.commandPrefix;

  return {
    name: "bash",
    label: "Shell Command",
    description: `Execute a bash command in the working directory. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: z.toJSONSchema(bashSchema, { target: "draft-7" }) as Record<string, unknown>,
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const { command, timeout } = bashSchema.parse(input);
      const resolvedCwd = cwd ?? ctx.runtime.cwd;
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;

      let tempFilePath: string | undefined;
      let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      let chunksBytes = 0;
      const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

      const handleData = (data: Buffer) => {
        totalBytes += data.length;

        // Start writing to temp file once we exceed the threshold
        if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
          tempFilePath = getTempFilePath();
          tempFileStream = createWriteStream(tempFilePath);
          for (const chunk of chunks) tempFileStream.write(chunk);
        }
        if (tempFileStream) tempFileStream.write(data);

        // Keep rolling buffer of recent data
        chunks.push(data);
        chunksBytes += data.length;
        while (chunksBytes > maxChunksBytes && chunks.length > 1) {
          const removed = chunks.shift()!;
          chunksBytes -= removed.length;
        }

        // Stream progress to the UI
        if (ctx.onProgress) {
          ctx.onProgress(Buffer.concat(chunks).toString("utf-8"));
        }
      };

      try {
        const result = await ctx.runtime.exec(resolvedCommand, {
          cwd: resolvedCwd,
          timeout,
          signal: ctx.signal,
          onData: handleData,
        });

        if (tempFileStream) tempFileStream.end();

        const fullBuffer = Buffer.concat(chunks);
        const fullOutput = fullBuffer.toString("utf-8");
        const truncation = truncateTail(fullOutput);
        let outputText = truncation.content || "(no output)";

        if (truncation.truncated) {
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;

          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(
              Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"),
            );
            outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
          } else if (truncation.truncatedBy === "lines") {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
          } else {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
          }
        }

        if (tempFilePath) unlink(tempFilePath, () => {});

        if (result.exitCode !== 0 && result.exitCode !== null) {
          outputText += `\n\nCommand exited with code ${result.exitCode}`;
          throw new Error(outputText);
        }

        return outputText;
      } catch (err) {
        if (tempFileStream) tempFileStream.end();
        if (tempFilePath) unlink(tempFilePath, () => {});

        if (err instanceof Error) {
          const fullBuffer = Buffer.concat(chunks);
          let output = fullBuffer.toString("utf-8");

          if (isAbortError(err)) {
            if (output) output += "\n\n";
            output += "Command aborted";
            throw new Error(output);
          }
          if (isTimeoutError(err)) {
            const timeoutSecs = extractTimeoutSecs(err, timeout);
            if (output) output += "\n\n";
            output += `Command timed out after ${timeoutSecs} seconds`;
            throw new Error(output);
          }
        }
        throw err;
      }
    },
  };
}

/** Default bash tool. Uses ctx.runtime.cwd at execution time. */
export const BashTool = createBashTool();
