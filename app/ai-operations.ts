import { UserFacingError } from './errors.ts';

export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes?: number };
}
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

type Operation = { id: string; status: string; result_json: string | null; created_at: number };
export const AI_HOURLY_LIMIT = 6;
export const AI_DAILY_LIMIT = 20;
const LEASE_MS = 180_000;

export async function inputHash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// One atomic conditional insert enforces the limits across tabs/Worker isolates.
// Completed matching inputs are reused for a day; failed calls count toward limits.
export async function claimOperation(db: SqlDatabase, owner: string, kind: string, hash: string, now = Date.now()) {
  await db.prepare('DELETE FROM ai_operations WHERE created_at < ?').bind(now - 7 * 86_400_000).run();
  const existing = await db.prepare(`SELECT id, status, result_json, created_at FROM ai_operations
    WHERE owner_email = ? AND kind = ? AND input_hash = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
    .bind(owner, kind, hash, now - 86_400_000).first<Operation>();
  if (existing?.status === 'succeeded' && existing.result_json) {
    return { cached: JSON.parse(existing.result_json) as unknown, id: existing.id };
  }
  if (existing?.status === 'processing' && existing.created_at > now - LEASE_MS) {
    throw new UserFacingError('This request is already running. Wait a moment before trying again.', 409);
  }
  if (existing && existing.status !== 'succeeded' && existing.created_at > now - 60_000) {
    throw new UserFacingError('Wait one minute before retrying this AI request.', 429);
  }
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO ai_operations (id, owner_email, kind, input_hash, status, created_at)
    SELECT ?, ?, ?, ?, 'processing', ?
    WHERE NOT EXISTS (SELECT 1 FROM ai_operations WHERE owner_email = ? AND status = 'processing' AND created_at > ?)
      AND NOT EXISTS (SELECT 1 FROM ai_operations WHERE owner_email = ? AND kind = ? AND input_hash = ? AND status = 'succeeded' AND created_at > ?)
      AND (SELECT count(*) FROM ai_operations WHERE owner_email = ? AND created_at > ?) < ?
      AND (SELECT count(*) FROM ai_operations WHERE owner_email = ? AND created_at > ?) < ?`)
    .bind(id, owner, kind, hash, now, owner, now - LEASE_MS,
      owner, kind, hash, now - 86_400_000, owner, now - 3_600_000, AI_HOURLY_LIMIT, owner, now - 86_400_000, AI_DAILY_LIMIT).run();
  if (result.meta.changes !== 1) {
    const completed = await db.prepare(`SELECT result_json FROM ai_operations WHERE owner_email = ? AND kind = ?
      AND input_hash = ? AND status = 'succeeded' AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
      .bind(owner, kind, hash, now - 86_400_000).first<{ result_json: string }>();
    if (completed?.result_json) return { id, cached: JSON.parse(completed.result_json) as unknown };
    throw new UserFacingError('Another AI request is running or your limit was reached (6 per hour, 20 per day). Try later.', 429);
  }
  return { id, cached: undefined };
}

export async function completeOperation(db: SqlDatabase, id: string, result: unknown) {
  await db.prepare("UPDATE ai_operations SET status = 'succeeded', result_json = ? WHERE id = ? AND status = 'processing'")
    .bind(JSON.stringify(result), id).run();
}
export async function failOperation(db: SqlDatabase, id: string) {
  await db.prepare("UPDATE ai_operations SET status = 'failed' WHERE id = ? AND status = 'processing'").bind(id).run();
}

export async function runAiOperation<T>(db: SqlDatabase, owner: string, kind: string, input: unknown, work: () => Promise<T>) {
  const claim = await claimOperation(db, owner, kind, await inputHash(input));
  if (claim.cached !== undefined) return claim.cached as T;
  try {
    const result = await work();
    await completeOperation(db, claim.id, result);
    return result;
  } catch (error) {
    await failOperation(db, claim.id);
    throw error;
  }
}
