import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate";

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe("formatSize", () => {
  test("formats bytes", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1023)).toBe("1023B");
  });

  test("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1536)).toBe("1.5KB");
    expect(formatSize(1024 * 1023)).toBe("1023.0KB");
  });

  test("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5MB");
  });
});

// ---------------------------------------------------------------------------
// truncateTail — no truncation
// ---------------------------------------------------------------------------

describe("truncateTail — no truncation", () => {
  test("returns content unchanged when within limits", () => {
    const content = "line 1\nline 2\nline 3";
    const result = truncateTail(content);

    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeNull();
    expect(result.totalLines).toBe(3);
    expect(result.outputLines).toBe(3);
    expect(result.lastLinePartial).toBe(false);
  });

  test("handles empty string", () => {
    const result = truncateTail("");

    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1); // "".split("\n") → [""]
    expect(result.outputLines).toBe(1);
  });

  test("handles single line", () => {
    const result = truncateTail("hello world");

    expect(result.content).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
  });

  test("uses default limits", () => {
    const result = truncateTail("test");
    expect(result.maxLines).toBe(DEFAULT_MAX_LINES);
    expect(result.maxBytes).toBe(DEFAULT_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// truncateTail — line truncation
// ---------------------------------------------------------------------------

describe("truncateTail — line truncation", () => {
  test("truncates to last N lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const result = truncateTail(content, { maxLines: 3 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.content).toBe("line 8\nline 9\nline 10");
    expect(result.outputLines).toBe(3);
    expect(result.totalLines).toBe(10);
    expect(result.lastLinePartial).toBe(false);
  });

  test("keeps exactly maxLines lines", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const result = truncateTail(content, { maxLines: 5 });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.outputLines).toBe(5);
  });

  test("maxLines: 1 returns last line", () => {
    const result = truncateTail("a\nb\nc", { maxLines: 1 });

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("c");
    expect(result.outputLines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// truncateTail — byte truncation
// ---------------------------------------------------------------------------

describe("truncateTail — byte truncation", () => {
  test("truncates when byte limit is hit before line limit", () => {
    // Each line is "aaaa\n" = 5 bytes (except last has no trailing newline)
    const lines = Array.from({ length: 20 }, () => "aaaa");
    const content = lines.join("\n");
    // maxBytes = 25, maxLines high — should hit bytes first
    const result = truncateTail(content, { maxBytes: 25, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(25);
  });

  test("single line exceeding maxBytes returns partial line from the end", () => {
    const longLine = "x".repeat(200);
    const result = truncateTail(longLine, { maxBytes: 50, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.lastLinePartial).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(50);
    // Should contain the END of the string
    expect(result.content).toBe("x".repeat(50));
  });
});

// ---------------------------------------------------------------------------
// truncateTail — UTF-8 boundary handling
// ---------------------------------------------------------------------------

describe("truncateTail — UTF-8 boundaries", () => {
  test("handles multi-byte characters without breaking them", () => {
    // 🎉 is 4 bytes in UTF-8
    const longLine = "🎉".repeat(100); // 400 bytes
    const result = truncateTail(longLine, { maxBytes: 50, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    // Should not contain broken UTF-8 sequences — round-trip must be clean
    const buf = Buffer.from(result.content, "utf-8");
    expect(buf.toString("utf-8")).toBe(result.content);
    // Each emoji is 4 bytes, so 50/4 = 12.5, should get 12 emojis = 48 bytes
    expect(buf.length).toBeLessThanOrEqual(50);
  });

  test("handles 2-byte UTF-8 characters", () => {
    // é is 2 bytes in UTF-8
    const longLine = "é".repeat(100); // 200 bytes
    const result = truncateTail(longLine, { maxBytes: 30, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    // Should contain valid characters, no broken sequences
    for (const char of result.content) {
      expect(char).toBe("é");
    }
  });
});

// ---------------------------------------------------------------------------
// truncateTail — custom options
// ---------------------------------------------------------------------------

describe("truncateTail — custom options", () => {
  test("respects custom maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result = truncateTail(lines.join("\n"), { maxLines: 10 });

    expect(result.maxLines).toBe(10);
    expect(result.outputLines).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test("respects custom maxBytes", () => {
    const result = truncateTail("a".repeat(200), { maxBytes: 100 });

    expect(result.maxBytes).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(100);
  });

  test("both limits interact — line limit wins", () => {
    // 5 short lines, maxLines=2, maxBytes very high
    const result = truncateTail("a\nb\nc\nd\ne", { maxLines: 2, maxBytes: 100_000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.content).toBe("d\ne");
  });

  test("both limits interact — byte limit wins", () => {
    // 5 lines, each 10 chars, maxLines high, maxBytes small
    const lines = Array.from({ length: 5 }, () => "abcdefghij");
    const result = truncateTail(lines.join("\n"), { maxLines: 1000, maxBytes: 25 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
  });
});

// ---------------------------------------------------------------------------
// truncateTail — metadata accuracy
// ---------------------------------------------------------------------------

describe("truncateTail — metadata", () => {
  test("totalBytes matches Buffer.byteLength of input", () => {
    const content = "hello\nworld\n🎉";
    const result = truncateTail(content);

    expect(result.totalBytes).toBe(Buffer.byteLength(content, "utf-8"));
  });

  test("outputBytes matches Buffer.byteLength of output", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = truncateTail(lines.join("\n"), { maxLines: 5 });

    expect(result.outputBytes).toBe(Buffer.byteLength(result.content, "utf-8"));
  });

  test("totalLines counts correctly with trailing newline", () => {
    // "a\nb\n" splits into ["a", "b", ""] — 3 elements
    const result = truncateTail("a\nb\n");
    expect(result.totalLines).toBe(3);
  });
});
