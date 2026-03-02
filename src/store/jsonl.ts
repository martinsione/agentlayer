import { mkdir, appendFile, readFile, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { SessionEntry, SessionStore } from "../types";

export class JsonlSessionStore implements SessionStore {
  private readonly dir: string;
  private dirEnsured = false;
  /** Per-session write queues to serialize appends and prevent interleaved writes. */
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private filePath(sessionId: string): string {
    const resolved = resolve(this.dir, `${sessionId}.jsonl`);
    // Ensure the resolved path stays within the configured directory.
    // Use dir + sep to avoid prefix false-positives (e.g. dir "foo" matching "foobar/x").
    if (!resolved.startsWith(this.dir + "/")) {
      throw new Error(`Invalid sessionId: path escapes store directory`);
    }
    return resolved;
  }

  async load(sessionId: string): Promise<SessionEntry[]> {
    try {
      const content = await readFile(this.filePath(sessionId), "utf-8");
      const entries: SessionEntry[] = [];
      for (const line of content.split("\n")) {
        if (line.length === 0) continue;
        try {
          entries.push(JSON.parse(line) as SessionEntry);
        } catch {
          // Skip malformed lines (e.g. partial writes from a crash)
        }
      }
      return entries;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    const path = this.filePath(sessionId);

    // Chain writes per session so concurrent appends never interleave bytes.
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(path), { recursive: true });
        this.dirEnsured = true;
      }
      await appendFile(path, JSON.stringify(entry) + "\n");
    });
    this.writeQueues.set(sessionId, next);
    await next;
  }

  async exists(sessionId: string): Promise<boolean> {
    const path = this.filePath(sessionId); // throws on path traversal before try/catch
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
