import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Db = Database.Database;

/** One exported table: its file, its natural ordering, and which columns hold JSON. */
interface TableSpec {
  table: string;
  file: string;
  orderBy: string;
  json: string[];
  jsonl?: boolean;
}

export const TABLES: TableSpec[] = [
  { table: "spec", file: "specs.json", orderBy: "seq", json: ["gate", "artefacts", "health", "moved"] },
  { table: "task", file: "tasks.json", orderBy: "seq, ordinal, local_id", json: ["requirements"] },
  { table: "artefact_hash", file: "artefact-hashes.json", orderBy: "seq, local_id, path", json: [] },
  { table: "run", file: "runs.json", orderBy: "started_at, run_key", json: [] },
  { table: "decision", file: "decisions.json", orderBy: "local_id", json: ["supersedes", "resolves", "rejects"] },
  { table: "question", file: "questions.json", orderBy: "local_id", json: [] },
  { table: "alternative", file: "alternatives.json", orderBy: "local_id", json: [] },
  { table: "evidence", file: "evidence.json", orderBy: "local_id", json: [] },
  { table: "memory", file: "memories.json", orderBy: "local_id", json: ["tags"] },
  { table: "handoff", file: "handoffs.json", orderBy: "local_id", json: [] },
  { table: "event", file: "events.jsonl", orderBy: "id", json: [], jsonl: true },
];

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "db", "schema.sql");

/** Recursively sort object keys so the same data always serialises to the same bytes. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value), null, 2) + "\n";
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The plane's persistence. SQLite runs in memory and is rebuilt from the committed
 * export whenever the export's bytes differ from what this process last loaded or wrote,
 * so a CLI write and a long-running MCP server never serve each other stale state.
 */
export class Store {
  db!: Db;
  readonly exportDir: string;
  private fingerprint = "";

  constructor(readonly root: string) {
    this.exportDir = join(root, ".stf", "export");
    mkdirSync(this.exportDir, { recursive: true });
    this.reload();
  }

  private readExportFiles(): Map<string, string> {
    const files = new Map<string, string>();
    for (const t of TABLES) {
      const p = join(this.exportDir, t.file);
      files.set(t.file, existsSync(p) ? readFileSync(p, "utf8") : "");
    }
    return files;
  }

  private static fingerprintOf(files: Map<string, string>): string {
    return sha256([...files.entries()].map(([k, v]) => `${k}\0${sha256(v)}`).join("\n"));
  }

  reload(): void {
    const files = this.readExportFiles();
    const db = new Database(":memory:");
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));
    const load = db.transaction(() => {
      for (const t of TABLES) {
        const text = files.get(t.file) ?? "";
        if (!text.trim()) continue;
        const rows: Record<string, unknown>[] = t.jsonl
          ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
          : JSON.parse(text);
        for (const row of rows) {
          const cols = Object.keys(row);
          const values = cols.map((c) => {
            const v = row[c];
            if (t.json.includes(c)) return v === null || v === undefined ? null : JSON.stringify(v);
            return typeof v === "boolean" ? (v ? 1 : 0) : v;
          });
          db.prepare(`INSERT INTO ${t.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...values);
        }
      }
    });
    load();
    this.db?.close();
    this.db = db;
    this.fingerprint = Store.fingerprintOf(files);
  }

  /** Pick up writes another process made since we last looked. */
  ensureFresh(): void {
    if (Store.fingerprintOf(this.readExportFiles()) !== this.fingerprint) this.reload();
  }

  /** Render every table exactly as it would be written. Pure: the round-trip test compares this. */
  render(): Map<string, string> {
    const out = new Map<string, string>();
    for (const t of TABLES) {
      const rows = (this.db.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.orderBy}`).all() as Record<string, unknown>[]).map((r) => {
        for (const c of t.json) if (typeof r[c] === "string") r[c] = JSON.parse(r[c] as string);
        return r;
      });
      if (t.jsonl) out.set(t.file, rows.map((r) => JSON.stringify(canonical(r)) + "\n").join(""));
      else out.set(t.file, stableJson(rows));
    }
    return out;
  }

  /** Write only the files whose bytes changed, atomically (tmp + rename). */
  export(): string[] {
    const changed: string[] = [];
    const current = this.readExportFiles();
    for (const [file, text] of this.render()) {
      if (current.get(file) === text) continue;
      const p = join(this.exportDir, file);
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, p);
      changed.push(file);
    }
    this.fingerprint = Store.fingerprintOf(this.readExportFiles());
    return changed;
  }

  /** Every mutation goes through here: refresh, apply atomically, export. */
  mutate<T>(fn: (db: Db) => T): T {
    this.ensureFresh();
    const result = this.db.transaction(() => fn(this.db))();
    this.export();
    return result;
  }

  read<T>(fn: (db: Db) => T): T {
    this.ensureFresh();
    return fn(this.db);
  }

  static exportFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
}
