/**
 * Edit tool — search-and-replace a string within a file.
 *
 * Delegates file I/O to `ctx.runtime.readFile()` / `ctx.runtime.writeFile()`.
 * Includes fuzzy matching fallbacks for whitespace and indentation mismatches.
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  old_string: z.string().describe("The text to find and replace"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z.boolean().optional().default(false).describe("Replace all occurrences"),
});

// ---------------------------------------------------------------------------
// Fuzzy matching strategies, tried in order:
// 1. Exact match
// 2. Trimmed whitespace match (trim each line)
// 3. Indentation-flexible match (ignore leading whitespace)
// ---------------------------------------------------------------------------

function exactMatch(content: string, target: string): number {
  return content.indexOf(target);
}

function trimmedMatch(content: string, target: string): { index: number; length: number } | null {
  const contentLines = content.split("\n");
  const targetLines = target.split("\n");
  const trimmedTarget = targetLines.map((l) => l.trim());

  for (let i = 0; i <= contentLines.length - targetLines.length; i++) {
    let match = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (contentLines[i + j]!.trim() !== trimmedTarget[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const startOffset = contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      const matchedText = contentLines.slice(i, i + targetLines.length).join("\n");
      return { index: startOffset, length: matchedText.length };
    }
  }
  return null;
}

function indentFlexibleMatch(
  content: string,
  target: string,
): { index: number; length: number } | null {
  const contentLines = content.split("\n");
  const targetLines = target.split("\n");
  const strippedTarget = targetLines.map((l) => l.trimStart());

  for (let i = 0; i <= contentLines.length - targetLines.length; i++) {
    let match = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (contentLines[i + j]!.trimStart() !== strippedTarget[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const startOffset = contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      const matchedText = contentLines.slice(i, i + targetLines.length).join("\n");
      return { index: startOffset, length: matchedText.length };
    }
  }
  return null;
}

function findMatch(content: string, target: string): { index: number; length: number } | null {
  // Strategy 1: Exact match
  const exactIdx = exactMatch(content, target);
  if (exactIdx !== -1) return { index: exactIdx, length: target.length };

  // Strategy 2: Trimmed whitespace
  const trimmed = trimmedMatch(content, target);
  if (trimmed) return trimmed;

  // Strategy 3: Indentation-flexible
  const indentFlex = indentFlexibleMatch(content, target);
  if (indentFlex) return indentFlex;

  return null;
}

function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean): string {
  if (replaceAll) {
    // For replace_all, try exact first, fall back to line-by-line
    if (content.includes(oldStr)) {
      return content.split(oldStr).join(newStr);
    }
    // Fuzzy replace_all: find all matches and replace
    let result = content;
    let match = findMatch(result, oldStr);
    while (match) {
      result = result.slice(0, match.index) + newStr + result.slice(match.index + match.length);
      match = findMatch(result, oldStr);
    }
    return result;
  }

  const match = findMatch(content, oldStr);
  if (!match) {
    throw new Error(
      "Could not find the specified text in the file. Make sure old_string matches exactly.",
    );
  }
  return content.slice(0, match.index) + newStr + content.slice(match.index + match.length);
}

export function createEditTool(cwd?: string): Tool {
  return defineTool({
    name: "edit",
    description:
      "Edit a file by replacing a specific string with a new string. " +
      "Provide the exact text to find (old_string) and the replacement (new_string). " +
      "Uses fuzzy matching for whitespace/indentation differences.",
    schema,
    execute: async (input, ctx) => {
      const filePath = resolve(cwd ?? ctx.runtime.cwd, input.path);

      if (input.old_string === input.new_string) {
        return "No changes needed — old_string and new_string are identical.";
      }

      const content = await ctx.runtime.readFile(filePath);
      const updated = applyEdit(content, input.old_string, input.new_string, input.replace_all);

      if (content === updated) {
        return "No changes were made — the old_string was not found in the file.";
      }

      await ctx.runtime.writeFile(filePath, updated);

      // Count replacements for reporting
      const originalCount = content.split(input.old_string).length - 1;
      const msg =
        input.replace_all && originalCount > 1
          ? `Edited ${filePath} (${originalCount} replacements)`
          : `Edited ${filePath}`;
      return msg;
    },
  });
}

/** Default edit tool. Uses ctx.runtime.cwd at execution time. */
export const EditTool = createEditTool();
