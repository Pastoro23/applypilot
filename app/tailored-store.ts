import type { SqlDatabase } from './ai-operations.ts';
import { UserFacingError } from './errors.ts';

export async function saveTailoredVersion(db: SqlDatabase, input: {
  id: string; owner: string; revision: number; tailored: unknown;
  description?: string; sourceResume?: string;
}) {
  const now = new Date().toISOString();
  const conditions = ['id = ?', 'owner_email = ?', 'tailored_revision = ?'];
  const bindings: unknown[] = [input.id, input.owner, input.revision];
  if (input.description !== undefined) {
    conditions.push('job_description = ?'); bindings.push(input.description);
  }
  if (input.sourceResume !== undefined) {
    conditions.push('EXISTS (SELECT 1 FROM master_resumes WHERE owner_email = ? AND content = ?)');
    bindings.push(input.owner, input.sourceResume);
  }
  const where = conditions.join(' AND ');
  const result = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO tailored_versions
      (id, owner_email, application_id, tailored_json, revision, created_at)
      SELECT id || ':' || tailored_revision, owner_email, id, tailored_json, tailored_revision, ?
      FROM applications WHERE ${where} AND tailored_json IS NOT NULL`).bind(now, ...bindings),
    db.prepare(`UPDATE applications SET tailored_json = ?, tailored_at = ?, updated_at = ?,
      tailored_revision = tailored_revision + 1 WHERE ${where}`)
      .bind(JSON.stringify(input.tailored), now, now, ...bindings),
  ]);
  if (result[1].meta.changes !== 1) {
    throw new UserFacingError('This application or source resume changed while you were working. Reload before saving or tailoring again.', 409);
  }
}
