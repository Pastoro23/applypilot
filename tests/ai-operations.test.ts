import test from 'node:test';
import assert from 'node:assert/strict';
import { claimOperation, completeOperation, failOperation, runAiOperation } from '../app/ai-operations.ts';
import { saveTailoredVersion } from '../app/tailored-store.ts';
import { testDatabase } from './sqlite-helper.ts';

test('identical completed AI work is reused without calling provider twice', async () => {
  const { db } = testDatabase(); let calls = 0;
  const work = async () => { calls++; return { text: 'result' }; };
  assert.deepEqual(await runAiOperation(db, 'a', 'pdf', { file: 'same' }, work), { text: 'result' });
  assert.deepEqual(await runAiOperation(db, 'a', 'pdf', { file: 'same' }, work), { text: 'result' });
  assert.equal(calls, 1);
});
test('overlapping AI requests are blocked across kinds and duplicates', async () => {
  const { db } = testDatabase();
  await claimOperation(db, 'a', 'pdf', 'file');
  await assert.rejects(claimOperation(db, 'a', 'pdf', 'file'), /already running/);
  await assert.rejects(claimOperation(db, 'a', 'tailor', 'job'), /Another AI request/);
  await claimOperation(db, 'other-owner', 'pdf', 'file');
});
test('failed attempts count toward the hourly limit; daily budget is independent', async () => {
  const { db, sqlite } = testDatabase(); const now = Date.now();
  for (let n = 0; n < 6; n++) { const c = await claimOperation(db, 'a', 'tailor', 'job' + n, now); await failOperation(db, c.id); }
  await assert.rejects(claimOperation(db, 'a', 'tailor', 'next', now), /limit was reached/);
  for (let n = 0; n < 20; n++) sqlite.prepare("INSERT INTO ai_operations VALUES (?, 'b', 'pdf', ?, 'failed', NULL, ?)").run('old' + n, 'hash' + n, now - 4_000_000);
  await assert.rejects(claimOperation(db, 'b', 'tailor', 'next', now), /limit was reached/);
});
test('a failed operation can be retried after cooldown and preserves attempt count', async () => {
  const { db, sqlite } = testDatabase(); const now = Date.now();
  const c = await claimOperation(db, 'a', 'pdf', 'hash', now); await failOperation(db, c.id);
  await assert.rejects(claimOperation(db, 'a', 'pdf', 'hash', now + 1000), /one minute/);
  await claimOperation(db, 'a', 'pdf', 'hash', now + 61_000);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM ai_operations').get()?.n, 2);
});
test('cache is scoped by owner and expired entries do not bypass current limits', async () => {
  const { db } = testDatabase(); const now = Date.now();
  const c = await claimOperation(db, 'a', 'pdf', 'hash', now - 2 * 86_400_000); await completeOperation(db, c.id, { private: true });
  assert.equal((await claimOperation(db, 'b', 'pdf', 'hash', now)).cached, undefined);
  assert.equal((await claimOperation(db, 'a', 'pdf', 'hash', now)).cached, undefined);
});
test('tailored changes keep prior versions; stale or other-owner writes cannot overwrite', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.prepare("INSERT INTO applications(id, owner_email, company, role) VALUES ('job','a','Company','Role')").run();
  await saveTailoredVersion(db, { id: 'job', owner: 'a', revision: 0, tailored: { text: 'first' } });
  await saveTailoredVersion(db, { id: 'job', owner: 'a', revision: 1, tailored: { text: 'edited' } });
  assert.equal(sqlite.prepare('SELECT tailored_json FROM tailored_versions').get()?.tailored_json, JSON.stringify({ text: 'first' }));
  await assert.rejects(saveTailoredVersion(db, { id: 'job', owner: 'a', revision: 1, tailored: { text: 'late' } }), /changed while/);
  await assert.rejects(saveTailoredVersion(db, { id: 'job', owner: 'b', revision: 2, tailored: {} }), /changed while/);
  assert.equal(sqlite.prepare('SELECT tailored_revision FROM applications').get()?.tailored_revision, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM tailored_versions').get()?.n, 1);
});
test('changed job description or master resume rejects a late AI result', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.prepare("INSERT INTO applications(id, owner_email, company, role, job_description) VALUES ('job','a','C','R','new description')").run();
  sqlite.prepare("INSERT INTO master_resumes(owner_email,content) VALUES('a','current resume')").run();
  await assert.rejects(saveTailoredVersion(db, { id: 'job', owner: 'a', revision: 0, tailored: {}, description: 'old description', sourceResume: 'current resume' }), /changed while/);
  await assert.rejects(saveTailoredVersion(db, { id: 'job', owner: 'a', revision: 0, tailored: {}, description: 'new description', sourceResume: 'old resume' }), /changed while/);
  assert.equal(sqlite.prepare('SELECT tailored_json FROM applications').get()?.tailored_json, null);
});

test('a completed duplicate is not charged again even if the initial cache read was stale', async () => {
  const { db, sqlite } = testDatabase(); const now = Date.now();
  const c = await claimOperation(db, 'a', 'pdf', 'race', now); await completeOperation(db, c.id, { text: 'done' });
  const racing = {
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.includes('SELECT id, status')) return statement;
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return { ...bound, first: async <T>() => null as T | null };
        },
      };
    },
  };
  const reused = await claimOperation(racing, 'a', 'pdf', 'race', now);
  assert.deepEqual(reused.cached, { text: 'done' });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM ai_operations').get()?.n, 1);
});
