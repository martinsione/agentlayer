import { z } from "zod";
import { defineTool } from "../define-tool";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export const WebFetchTool = defineTool({
  name: "web_fetch",
  description: "Fetch a URL and return the response body. Output is truncated to 50KB.",
  schema: z.object({
    url: z.string().describe("The URL to fetch"),
    method: z.string().optional().describe("HTTP method (default: GET)"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("HTTP headers as key-value pairs"),
    body: z.string().optional().describe("Request body"),
  }),
  execute: async (input, ctx) => {
    const url = input.url;
    const method = input.method ?? "GET";
    const headers = input.headers;
    const body = input.body;

    const signals = [AbortSignal.timeout(DEFAULT_TIMEOUT_MS)];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = AbortSignal.any(signals);

    const response = await fetch(url, { method, headers, body, signal });

    const contentType = response.headers.get("content-type") ?? "unknown";
    let truncated = false;

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = DEFAULT_MAX_BYTES - totalBytes;
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes >= DEFAULT_MAX_BYTES) {
        truncated = true;
        reader.cancel();
        break;
      }
    }

    const merged = Buffer.concat(chunks);
    const text = merged.toString("utf-8");

    let output = `Status: ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${text}`;
    if (truncated) {
      output += `\n\n[Output truncated at ${(DEFAULT_MAX_BYTES / 1024).toFixed(1)}KB.]`;
    }
    return output;
  },
});
