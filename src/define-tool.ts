import { z } from "zod";
import type { Tool, ToolContext } from "./types";

type ZodObjectSchema = z.ZodObject<z.core.$ZodLooseShape>;

/**
 * Define a tool with a typed input schema using zod.
 *
 * The zod schema is converted to JSON Schema for the `parameters` field,
 * and the `execute` callback receives the inferred TypeScript type as its
 * first argument instead of an untyped `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { defineTool } from "agentlayer/define-tool";
 *
 * const greet = defineTool({
 *   name: "greet",
 *   description: "Say hello",
 *   schema: z.object({ name: z.string() }),
 *   execute: async (input, ctx) => {
 *     // input.name is typed as string
 *     return `Hello, ${input.name}!`;
 *   },
 * });
 * ```
 */
export function defineTool<TSchema extends ZodObjectSchema>(opts: {
  name: string;
  description: string;
  schema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<string>;
}): Tool {
  return {
    name: opts.name,
    description: opts.description,
    parameters: z.toJSONSchema(opts.schema, { target: "draft-7" }) as Record<string, unknown>,
    execute: opts.execute as Tool["execute"],
  };
}
