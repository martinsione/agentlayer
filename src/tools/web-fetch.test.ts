import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebFetchTool } from "./web-fetch";

const runtime = {} as never; // WebFetchTool doesn't use runtime

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/hello") {
        return new Response("hello world", {
          headers: { "content-type": "text/plain" },
        });
      }

      if (url.pathname === "/large") {
        return new Response("x".repeat(60 * 1024), {
          headers: { "content-type": "text/plain" },
        });
      }

      if (url.pathname === "/echo") {
        const body = req.body ? await Bun.readableStreamToText(req.body) : null;
        return new Response(
          JSON.stringify({
            method: req.method,
            headers: Object.fromEntries(req.headers.entries()),
            body,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("WebFetchTool", () => {
  test("returns formatted output with status and content-type", async () => {
    const result = await WebFetchTool.execute({ url: `${baseUrl}/hello` }, { runtime });

    expect(result).toContain("Status: 200");
    expect(result).toContain("Content-Type: text/plain");
    expect(result).toContain("hello world");
  });

  test("forwards method, headers, and body to fetch", async () => {
    const result = await WebFetchTool.execute(
      {
        url: `${baseUrl}/echo`,
        method: "POST",
        headers: { "x-custom": "value" },
        body: "payload",
      },
      { runtime },
    );

    const jsonStart = result.indexOf("\n\n") + 2;
    const json = JSON.parse(result.slice(jsonStart));
    expect(json.method).toBe("POST");
    expect(json.headers["x-custom"]).toBe("value");
  });

  test("truncates response at 50KB and appends notice", async () => {
    const result = await WebFetchTool.execute({ url: `${baseUrl}/large` }, { runtime });

    expect(result).toContain("[Output truncated at 50.0KB.]");
    const bodyStart = result.indexOf("\n\n") + 2;
    const bodyEnd = result.indexOf("\n\n[Output truncated");
    expect(bodyEnd - bodyStart).toBe(50 * 1024);
  });

  test("does not truncate small responses", async () => {
    const result = await WebFetchTool.execute({ url: `${baseUrl}/hello` }, { runtime });

    expect(result).not.toContain("[Output truncated");
  });

  test("reports non-200 status", async () => {
    const result = await WebFetchTool.execute({ url: `${baseUrl}/nope` }, { runtime });

    expect(result).toContain("Status: 404");
  });
});
