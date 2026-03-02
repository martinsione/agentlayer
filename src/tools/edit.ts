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

/** Sliding-window line match with a configurable normalizer. */
function fuzzyLineMatch(
  contentLines: string[],
  targetLines: string[],
  normalize: (line: string) => string,
): { index: number; length: number } | null {
  const normalizedTarget = targetLines.map(normalize);
  for (let i = 0; i <= contentLines.length - targetLines.length; i++) {
    if (targetLines.every((_, j) => normalize(contentLines[i + j]!) === normalizedTarget[j])) {
      const startOffset = contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      const matchedText = contentLines.slice(i, i + targetLines.length).join("\n");
      return { index: startOffset, length: matchedText.length };
    }
  }
  return null;
}

function findMatch(content: string, target: string): { index: number; length: number } | null {
  // Strategy 1: Exact match
  const exactIdx = content.indexOf(target);
  if (exactIdx !== -1) return { index: exactIdx, length: target.length };

  // Strategies 2-3: fuzzy line matching (split once, reuse)
  const contentLines = content.split("\n");
  const targetLines = target.split("\n");

  return (
    fuzzyLineMatch(contentLines, targetLines, (l) => l.trim()) ??
    fuzzyLineMatch(contentLines, targetLines, (l) => l.trimStart())
  );
}

function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): { result: string; count: number } {
  if (replaceAll) {
    // For replace_all, try exact first, fall back to line-by-line
    if (content.includes(oldStr)) {
      const parts = content.split(oldStr);
      return { result: parts.join(newStr), count: parts.length - 1 };
    }
    // Fuzzy replace_all: collect all match positions, then apply back-to-front
    const matches: { index: number; length: number }[] = [];
    let searchFrom = 0;
    while (searchFrom < content.length) {
      const match = findMatch(content.slice(searchFrom), oldStr);
      if (!match) break;
      matches.push({ index: searchFrom + match.index, length: match.length });
      searchFrom += match.index + match.length;
    }
    if (matches.length === 0) {
      throw new Error(
        "Could not find the specified text in the file. Make sure old_string matches exactly.",
      );
    }
    let result = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!;
      result = result.slice(0, m.index) + newStr + result.slice(m.index + m.length);
    }
    return { result, count: matches.length };
  }

  const match = findMatch(content, oldStr);
  if (!match) {
    throw new Error(
      "Could not find the specified text in the file. Make sure old_string matches exactly.",
    );
  }
  return {
    result: content.slice(0, match.index) + newStr + content.slice(match.index + match.length),
    count: 1,
  };
}

export function createEditTool(cwd?: string): Tool {
  return defineTool({
    name: "edit",
    label: "Edit File",
    description:
      "Edit a file by replacing a specific string with a new string. " +
      "Provide the exact text to find (old_string) and the replacement (new_string). " +
      "Uses fuzzy matching for whitespace/indentation differences.",
    schema,
    execute: async (input, ctx) => {
      const filePath = resolve(cwd ?? ctx.runtime.cwd, input.path);

      if (input.old_string === "") {
        throw new Error(
          "old_string must not be empty. Provide the exact text you want to replace.",
        );
      }

      if (input.old_string === input.new_string) {
        return "No changes needed — old_string and new_string are identical.";
      }

      const content = await ctx.runtime.readFile(filePath);
      const { result: updated, count } = applyEdit(
        content,
        input.old_string,
        input.new_string,
        input.replace_all,
      );

      await ctx.runtime.writeFile(filePath, updated);

      return count > 1 ? `Edited ${filePath} (${count} replacements)` : `Edited ${filePath}`;
    },
  });
}

/** Default edit tool. Uses ctx.runtime.cwd at execution time. */
export const EditTool = createEditTool();
