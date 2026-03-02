import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import { DEFAULT_MAX_BYTES } from "./truncate";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface WebFetchToolOptions {
  /** Request timeout in milliseconds. Default: 15 000. */
  timeoutMs?: number;
  /** Maximum response body size in bytes. Default: 50 KB. */
  maxBytes?: number;
}

const webFetchSchema = z.object({
  url: z.string().describe("The URL to fetch"),
  method: z.string().optional().describe("HTTP method (default: GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("HTTP headers as key-value pairs"),
  body: z.string().optional().describe("Request body"),
});

/**
 * Create a web fetch tool with configurable timeout and body-size limits.
 *
 * @example
 * ```ts
 * import { createWebFetchTool } from "agentlayer/tools/web-fetch";
 *
 * const tool = createWebFetchTool({ timeoutMs: 30_000, maxBytes: 100 * 1024 });
 * ```
 */
export function createWebFetchTool(options?: WebFetchToolOptions) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch a URL and return the response body. Output is truncated to ${(maxBytes / 1024).toFixed(1)}KB.`,
    schema: webFetchSchema,
    execute: async (input, ctx) => {
      const url = input.url;
      const method = input.method ?? "GET";
      const headers = input.headers;
      const body = input.body;

      const signals = [AbortSignal.timeout(timeoutMs)];
      if (ctx.signal) signals.push(ctx.signal);
      const signal = AbortSignal.any(signals);

      const response = await fetch(url, { method, headers, body, signal });

      const contentType = response.headers.get("content-type") ?? "unknown";
      let truncated = false;
      let text = "";

      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = maxBytes - totalBytes;
          const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
          chunks.push(chunk);
          totalBytes += chunk.length;
          if (totalBytes >= maxBytes) {
            truncated = true;
            reader.cancel();
            break;
          }
        }
        text = Buffer.concat(chunks).toString("utf-8");
      }

      let output = `Status: ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${text}`;
      if (truncated) {
        output += `\n\n[Output truncated at ${(maxBytes / 1024).toFixed(1)}KB.]`;
      }
      return output;
    },
  });
}

/** Default web fetch tool (15 s timeout, 50 KB limit). */
export const WebFetchTool = createWebFetchTool();
