import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "./define-tool";

describe("defineTool", () => {
  test("produces a Tool with correct name, description, and JSON Schema", () => {
    const tool = defineTool({
      name: "greet",
      description: "Say hello",
      schema: z.object({ name: z.string() }),
      execute: async (input) => `Hello, ${input.name}!`,
    });

    expect(tool.name).toBe("greet");
    expect(tool.description).toBe("Say hello");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  test("handles optional fields in schema", () => {
    const tool = defineTool({
      name: "test",
      description: "test",
      schema: z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
      execute: async () => "ok",
    });

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        required: { type: "string" },
        optional: { type: "string" },
      },
      required: ["required"],
    });
  });

  test("execute receives typed input and returns result", async () => {
    const tool = defineTool({
      name: "add",
      description: "Add two numbers",
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async (input) => String(input.a + input.b),
    });

    const result = await tool.execute({ a: 2, b: 3 }, { runtime: {} as never });
    expect(result).toBe("5");
  });
});
