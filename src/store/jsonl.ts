import { mkdir, appendFile, readFile, readdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionEntry, SessionStore } from "../types";

export class JsonlSessionStore implements SessionStore {
  private readonly dir: string;
  private dirEnsured = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
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
    if (!this.dirEnsured) {
      await mkdir(dirname(path), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(path, JSON.stringify(entry) + "\n");
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      await access(this.filePath(sessionId));
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
