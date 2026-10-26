import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { SqlDatabase, SqlStatement, SqlResult } from '../app/ai-operations.ts';
export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  }
  const wrap = (sql: string, values: unknown[] = []): SqlStatement => ({
    bind(...args) { return wrap(sql, args); },
    async first<T>() { return (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[], meta: {} }; },
    async run() {
      const result = sqlite.prepare(sql).run(...values as never[]);
      return { results: [], meta: { changes: Number(result.changes) } };
    },
  });
  let queue: Promise<unknown> = Promise.resolve();
  const db: SqlDatabase = {
    prepare: sql => wrap(sql),
    // Batches run one at a time, like D1 transactions, even when callers start several at once.
    batch(statements) {
      const run = async () => {
        sqlite.exec('BEGIN');
        try { const results: SqlResult[] = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
        catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      };
      const result = queue.then(run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return { sqlite, db };
}
