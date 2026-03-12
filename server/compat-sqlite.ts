/**
 * Compatibility layer: exposes bun:sqlite with a better-sqlite3-compatible API.
 * Only the subset used by server/db.ts is implemented.
 */
import { Database as BunDatabase } from 'bun:sqlite';

class StatementWrapper {
  private stmt: ReturnType<BunDatabase['prepare']>;
  constructor(stmt: ReturnType<BunDatabase['prepare']>) {
    this.stmt = stmt;
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.stmt.run(...params) as { changes: number; lastInsertRowid: number };
  }
  get(...params: unknown[]): unknown {
    return this.stmt.get(...params);
  }
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }
}

class DatabaseWrapper {
  private db: BunDatabase;

  constructor(filePath: string) {
    this.db = new BunDatabase(filePath, { create: true });
  }

  pragma(pragma: string): unknown {
    const result = this.db.run(`PRAGMA ${pragma}`);
    return result;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): () => T {
    const wrapped = this.db.transaction(fn);
    return wrapped as () => T;
  }

  close(): void {
    this.db.close();
  }
}

export default DatabaseWrapper;
export type { DatabaseWrapper as Database };
