import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { autofillProfileFromRow, buildAutofillProfile, profileHash } from '../app/profile-records.ts';
import {
  approveForSubmit, cancelSubmissions, claimSubmission, listSubmissions, loadSettings, recordResults, resolveSubmission,
  saveSettings, submissionsPage, targetsFor, type ApprovedItem, type ClaimResult,
} from '../app/submission-store.ts';
import { UserFacingError } from '../app/errors.ts';
import { testDatabase } from './sqlite-helper.ts';

const OWNER = 'peter@example.com';
const OTHER = 'someone@example.com';
const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ghUrl = (id: string | number, board = 'acme') => `https://job-boards.greenhouse.io/${board}/jobs/${id}`;
const LEVER = (n: number) => `https://jobs.lever.co/beta/5a1b2c3d-1111-2222-3333-${String(n).padStart(12, '0')}`;

function setup() {
  const { sqlite, db } = testDatabase();
  for (const owner of [OWNER, OTHER]) {
    sqlite.prepare(`INSERT INTO profiles (owner_email, first_name, last_name, profile_email, phone, city, state, postal_code,
      identity_status, location_status, work_history_status) VALUES (?, 'Peter', 'Olatunde', 'p@example.com', '404-000-0000',
      'Grayson', 'GA', '30017', 'confirmed', 'confirmed', 'confirmed')`).run(owner);
  }
  return { sqlite, db };
}

function addApp(sqlite: DatabaseSync, id: string, url: string, opts: { status?: string; revision?: number; tailored?: boolean; owner?: string } = {}) {
  sqlite.prepare(`INSERT INTO applications (id, owner_email, company, role, url, status, tailored_json, tailored_at, tailored_revision)
    VALUES (?, ?, 'Acme', 'IT Support Specialist', ?, ?, ?, ?, ?)`)
    .run(id, opts.owner ?? OWNER, url, opts.status ?? 'saved', opts.tailored === false ? null : '{"resume":{}}', iso(NOW - HOUR), opts.revision ?? 1);
}

async function currentHash(sqlite: DatabaseSync, owner = OWNER) {
  const row = sqlite.prepare('SELECT * FROM profiles WHERE owner_email = ?').get(owner) as Record<string, unknown>;
  return profileHash(buildAutofillProfile(autofillProfileFromRow(row)));
}

const state = (sqlite: DatabaseSync, id: string) =>
  (sqlite.prepare('SELECT state FROM submissions WHERE id = ?').get(id) as { state: string } | undefined)?.state;
const appStatus = (sqlite: DatabaseSync, id: string) =>
  (sqlite.prepare('SELECT status FROM applications WHERE id = ?').get(id) as { status: string }).status;
const events = (sqlite: DatabaseSync, submissionId: string) =>
  (sqlite.prepare('SELECT event FROM submission_events WHERE submission_id = ? ORDER BY rowid').all(submissionId) as { event: string }[]).map((e) => e.event);

async function approveOne(db: ReturnType<typeof testDatabase>['db'], id: string, now = NOW, revision = 1, owner = OWNER) {
  const result = await approveForSubmit(db, owner, [{ applicationId: id, revision }], { includeCoverLetter: true, now });
  assert.equal(result.approved.length, 1, JSON.stringify(result.skipped));
  return result.approved[0];
}

function claimOf(item: ApprovedItem, extra: Record<string, unknown> = {}) {
  return {
    approvalId: item.approvalId, attemptId: crypto.randomUUID(), applicationId: item.applicationId, jobKey: item.jobKey,
    resumeSha256: 'a'.repeat(64), resumeFilename: 'Peter_Olatunde_Resume.pdf', profileHash: item.profileHash, pageUrl: item.applyUrls[0],
    fingerprint: 'f1a2', relaxations: [], extensionVersion: '3.0.0',
    fillReport: [{ label: 'First name', type: 'text', required: true, value: 'Peter', source: 'profile' }], ...extra,
  };
}

function resultOf(item: ApprovedItem, attemptId: string | null, outcome: string, extra: Record<string, unknown> = {}) {
  const clicked = outcome === 'submitted' || outcome === 'check';
  return {
    resultId: crypto.randomUUID(), approvalId: item.approvalId, attemptId, applicationId: item.applicationId, jobKey: item.jobKey,
    outcome, clicked, clickedBy: clicked ? 'applypilot' : '', reasons: [], pageUrl: item.applyUrls[0], confirmationText: '',
    startedAt: iso(NOW), finishedAt: iso(NOW + MIN), extensionVersion: '3.0.0', ...extra,
  };
}

async function claimed(db: ReturnType<typeof testDatabase>['db'], item: ApprovedItem, now = NOW, extra: Record<string, unknown> = {}) {
  const req = claimOf(item, extra);
  const result = await claimSubmission(db, OWNER, req, now);
  assert.equal(result.ok, true, JSON.stringify(result));
  return req.attemptId;
}

// Three supervised submissions Peter clicked himself and ApplyPilot saw confirmed.
function calibrate(sqlite: DatabaseSync, ats: string, n = 3) {
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision, profile_hash,
      state, approved_at, expires_at, claim_mode, clicked_by, updated_at) VALUES (?, ?, ?, ?, ?, '', 1, '', 'submitted', ?, ?, 'supervised', 'you', ?)`)
      .run(id, OWNER, `old-${ats}-${i}`, `${ats}:old:${i}`, ats, iso(NOW - 40 * 86_400_000), iso(NOW), iso(NOW - 40 * 86_400_000));
    sqlite.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      VALUES (?, ?, ?, ?, 'server', 'calibrated', '{}')`).run(`${id}:calibrated`, OWNER, id, iso(NOW - 40 * 86_400_000));
  }
}

const calibration = async (db: ReturnType<typeof testDatabase>['db']) => (await submissionsPage(db, OWNER, NOW + HOUR)).calibration;

const settings = (extra: Record<string, unknown> = {}) => ({
  auto: { greenhouse: false, lever: false, ashby: false }, dailyCap: 10, allowInvisibleCaptcha: true, allowOptionalSensitiveBlank: true, ...extra,
});

test('approve requires a confirmed profile', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  sqlite.prepare("UPDATE profiles SET location_status = 'needs_confirmation' WHERE owner_email = ?").run(OWNER);
  await assert.rejects(approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }], { includeCoverLetter: true, now: NOW }),
    (error: unknown) => error instanceof UserFacingError && error.status === 400 && /Confirm your name, location and work history/.test(error.message));
  sqlite.prepare("UPDATE profiles SET location_status = 'confirmed', last_name = '' WHERE owner_email = ?").run(OWNER);
  await assert.rejects(approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }], { includeCoverLetter: true, now: NOW }), UserFacingError);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM submissions').get()!.n, 0);
});

test('approve skips jobs that are not ready, with a reason for each', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'untailored', ghUrl(1), { tailored: false });
  addApp(sqlite, 'edited', ghUrl(2), { revision: 2 });
  addApp(sqlite, 'applied', ghUrl(3), { status: 'applied' });
  addApp(sqlite, 'company', 'https://acme.com/careers?gh_jid=4');
  addApp(sqlite, 'sent', ghUrl(5));
  addApp(sqlite, 'busy', ghUrl(6));
  addApp(sqlite, 'ok', ghUrl(7));
  calibrate(sqlite, 'lever', 0);
  sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision, profile_hash,
    state, approved_at, expires_at, updated_at) VALUES ('s-old', ?, 'gone', 'greenhouse:acme:5', 'greenhouse', ?, 1, '', 'submitted', ?, ?, ?)`)
    .run(OWNER, ghUrl(5), iso(NOW - 86_400_000), iso(NOW), iso(NOW - 86_400_000));
  await claimed(db, await approveOne(db, 'busy'));
  const result = await approveForSubmit(db, OWNER, ['untailored', 'edited', 'applied', 'company', 'sent', 'busy', 'ok', 'missing']
    .map((applicationId) => ({ applicationId, revision: 1 })), { includeCoverLetter: true, now: NOW });
  assert.deepEqual(result.approved.map((item) => item.applicationId), ['ok']);
  assert.deepEqual(Object.fromEntries(result.skipped.map((s) => [s.applicationId, s.code])), {
    untailored: 'not_tailored', edited: 'resume_changed', applied: 'final_status', company: 'unsupported_site',
    sent: 'already_submitted', busy: 'in_progress', missing: 'not_found',
  });
  const reasons = Object.fromEntries(result.skipped.map((s) => [s.applicationId, s.reason]));
  assert.equal(reasons.untailored, 'Make the tailored resume first');
  assert.equal(reasons.edited, 'The resume changed. Review it again.');
  assert.equal(reasons.applied, 'Already marked applied');
  assert.equal(reasons.company, 'Company site, not Greenhouse, Lever or Ashby: apply yourself');
  assert.equal(reasons.busy, 'ApplyPilot is sending this or needs you to check it');
});

test('approve is idempotent within 24 hours and replaces a stale approval', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const first = await approveOne(db, 'a1');
  assert.equal(first.expiresAt, iso(NOW + 24 * HOUR));
  assert.equal(first.profileHash, await currentHash(sqlite));
  assert.equal(first.includeCoverLetter, true);
  const again = await approveOne(db, 'a1', NOW + HOUR);
  assert.equal(again.approvalId, first.approvalId);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM submissions').get()!.n, 1);

  // The resume was re-tailored: the old approval is replaced.
  sqlite.prepare("UPDATE applications SET tailored_revision = 2 WHERE id = 'a1'").run();
  const replacing = await approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 2 }], { includeCoverLetter: true, now: NOW + 2 * HOUR });
  const second = replacing.approved[0];
  assert.notEqual(second.approvalId, first.approvalId);
  // The dashboard cancels the replaced approval in Chrome, or Chrome refuses the new one as a duplicate.
  assert.deepEqual(replacing.replaced, [first.approvalId]);
  const reused = await approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 2 }], { includeCoverLetter: true, now: NOW + 2 * HOUR });
  assert.deepEqual(reused.replaced, [], 'nothing replaced when the approval is reused');
  assert.equal(state(sqlite, first.approvalId), 'revoked');
  assert.equal((sqlite.prepare('SELECT reason FROM submissions WHERE id = ?').get(first.approvalId) as { reason: string }).reason, 'Replaced by a new approval');
  // The profile changed: replaced again.
  sqlite.prepare("UPDATE profiles SET phone = '404-111-1111' WHERE owner_email = ?").run(OWNER);
  const third = await approveOne(db, 'a1', NOW + 3 * HOUR, 2);
  assert.notEqual(third.approvalId, second.approvalId);
  assert.equal(state(sqlite, second.approvalId), 'revoked');
  assert.equal(third.profileHash, await currentHash(sqlite));
  // Turning the cover letter off is a different approval too.
  const fourth = (await approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 2 }], { includeCoverLetter: false, now: NOW + 4 * HOUR })).approved[0];
  assert.notEqual(fourth.approvalId, third.approvalId);
  assert.equal(fourth.includeCoverLetter, false);
  assert.deepEqual(events(sqlite, first.approvalId), ['approved', 'revoked']);
});

test('approve sweeps expired approvals', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  addApp(sqlite, 'a2', ghUrl(2));
  const first = await approveOne(db, 'a1');
  await approveOne(db, 'a2', NOW + 25 * HOUR);
  assert.equal(state(sqlite, first.approvalId), 'expired');
  assert.deepEqual(events(sqlite, first.approvalId), ['approved', 'expired']);
  const renewed = await approveOne(db, 'a1', NOW + 25 * HOUR);
  assert.notEqual(renewed.approvalId, first.approvalId);
});

test('one live row per job, across applications', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(9));
  addApp(sqlite, 'a2', ghUrl(9));
  addApp(sqlite, 'a3', ghUrl(9));
  const both = await approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }, { applicationId: 'a2', revision: 1 }],
    { includeCoverLetter: true, now: NOW });
  assert.deepEqual(both.approved.map((item) => item.applicationId), ['a1']);
  assert.equal(both.skipped[0].applicationId, 'a2');
  const live = both.approved[0];
  assert.throws(() => sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision,
    profile_hash, state, approved_at, expires_at, updated_at) VALUES ('dup', ?, 'a2', ?, 'greenhouse', '', 1, '', 'approved', ?, ?, ?)`)
    .run(OWNER, live.jobKey, iso(NOW), iso(NOW + HOUR), iso(NOW)), /UNIQUE/);
  // A submitted row is outside the index, so a late "you submitted it" never fails on it.
  sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision,
    profile_hash, state, approved_at, expires_at, updated_at) VALUES ('done', ?, 'a2', ?, 'greenhouse', '', 1, '', 'submitted', ?, ?, ?)`)
    .run(OWNER, live.jobKey, iso(NOW), iso(NOW + HOUR), iso(NOW));
  sqlite.prepare("DELETE FROM submissions WHERE id = 'done'").run();
  await claimed(db, live);
  const later = await approveForSubmit(db, OWNER, [{ applicationId: 'a3', revision: 1 }], { includeCoverLetter: true, now: NOW + MIN });
  assert.deepEqual(later.skipped.map((s) => s.code), ['in_progress']);
});

test('a found Greenhouse job is sent to its hosted form, not the company site', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', 'https://acme.com/careers?gh_jid=4012345');
  sqlite.prepare("INSERT INTO job_sources (id, owner_email, kind, token) VALUES ('src1', ?, 'greenhouse', 'Acme')").run(OWNER);
  sqlite.prepare(`INSERT INTO found_jobs (id, owner_email, source_id, kind, external_id, company, title, url, status, application_id)
    VALUES ('f1', ?, 'src1', 'greenhouse', '4012345', 'Acme', 'IT Support', 'https://acme.com/careers?gh_jid=4012345', 'queued', 'a1')`).run(OWNER);
  const item = await approveOne(db, 'a1');
  assert.equal(item.jobKey, 'greenhouse:acme:4012345');
  assert.deepEqual(item.applyUrls, ['https://job-boards.greenhouse.io/Acme/jobs/4012345',
    'https://job-boards.greenhouse.io/embed/job_app?for=Acme&token=4012345']);
  const row = sqlite.prepare('SELECT apply_url, ats FROM submissions WHERE id = ?').get(item.approvalId) as { apply_url: string; ats: string };
  assert.deepEqual({ ...row }, { apply_url: 'https://job-boards.greenhouse.io/Acme/jobs/4012345', ats: 'greenhouse' });
  const targets = await targetsFor(db, OWNER);
  assert.equal((targets.a1 as { jobKey: string }).jobKey, 'greenhouse:acme:4012345');
  const page = await submissionsPage(db, OWNER, NOW);
  assert.deepEqual(page.submissions[0].applyUrls, item.applyUrls);
});

test('approvals and claims are isolated per owner', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'mine', ghUrl(1));
  addApp(sqlite, 'theirs', ghUrl(1), { owner: OTHER });
  const skipped = await approveForSubmit(db, OWNER, [{ applicationId: 'theirs', revision: 1 }], { includeCoverLetter: true, now: NOW });
  assert.deepEqual(skipped.skipped.map((s) => s.code), ['not_found']);
  const mine = await approveOne(db, 'mine');
  const theirs = await approveOne(db, 'theirs', NOW, 1, OTHER);
  assert.equal(mine.jobKey, theirs.jobKey);
  assert.deepEqual(await claimSubmission(db, OTHER, claimOf(mine, { profileHash: await currentHash(sqlite, OTHER) }), NOW),
    { ok: false, reason: 'not_found' });
  assert.deepEqual((await cancelSubmissions(db, OTHER, [mine.approvalId], NOW)).revoked, []);
  assert.equal(state(sqlite, mine.approvalId), 'approved');
  assert.deepEqual((await listSubmissions(db, OTHER, NOW)).submissions.map((s) => s.id), [theirs.approvalId]);
});

test('approve takes 1 to 20 distinct jobs', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const many = Array.from({ length: 21 }, (_, n) => ({ applicationId: `x${n}`, revision: 1 }));
  await assert.rejects(approveForSubmit(db, OWNER, many, { includeCoverLetter: true, now: NOW }), UserFacingError);
  await assert.rejects(approveForSubmit(db, OWNER, [], { includeCoverLetter: true, now: NOW }), UserFacingError);
  await assert.rejects(approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }, { applicationId: 'a1', revision: 1 }],
    { includeCoverLetter: true, now: NOW }), UserFacingError);
  await assert.rejects(approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1.5 }], { includeCoverLetter: true, now: NOW }), UserFacingError);
  await assert.rejects(approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }], { includeCoverLetter: 'yes', now: NOW }), UserFacingError);
  const twenty = Array.from({ length: 20 }, (_, n) => ({ applicationId: `x${n}`, revision: 1 }));
  assert.equal((await approveForSubmit(db, OWNER, twenty, { includeCoverLetter: true, now: NOW })).skipped.length, 20);
});

test('only one of two concurrent claims wins', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const item = await approveOne(db, 'a1');
  const [a, b] = await Promise.all([claimSubmission(db, OWNER, claimOf(item), NOW), claimSubmission(db, OWNER, claimOf(item), NOW)]);
  assert.deepEqual([a, b].filter((r) => r.ok), [{ ok: true, mode: 'supervised' }]);
  assert.deepEqual([a, b].find((r) => !r.ok), { ok: false, reason: 'already_claimed' });
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed', 'claim_denied']);
  const row = sqlite.prepare('SELECT * FROM submissions WHERE id = ?').get(item.approvalId) as Record<string, unknown>;
  assert.equal(row.claim_mode, 'supervised');
  assert.equal(row.resume_sha256, 'a'.repeat(64));
  assert.equal(JSON.parse(String(row.fill_report_json))[0].label, 'First name');
  // A second claim later still gets nothing.
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(item), NOW + MIN), { ok: false, reason: 'already_claimed' });
});

test('claims are denied when anything approved has changed', async () => {
  const { sqlite, db } = setup();
  const ids = ['revoked', 'expired', 'edited', 'phone', 'applied', 'sent', 'setting', 'page'];
  ids.forEach((id, n) => addApp(sqlite, id, LEVER(n + 1)));
  const items: Record<string, ApprovedItem> = {};
  for (const id of ids) items[id] = await approveOne(db, id);
  const deny = async (id: string, now = NOW, extra: Record<string, unknown> = {}) => claimSubmission(db, OWNER, claimOf(items[id], extra), now);

  await cancelSubmissions(db, OWNER, [items.revoked.approvalId], NOW);
  assert.deepEqual(await deny('revoked'), { ok: false, reason: 'revoked' });
  sqlite.prepare("UPDATE applications SET tailored_revision = 2 WHERE id = 'edited'").run();
  assert.deepEqual(await deny('edited'), { ok: false, reason: 'resume_changed' });
  sqlite.prepare("UPDATE applications SET status = 'applied' WHERE id = 'applied'").run();
  assert.deepEqual(await deny('applied'), { ok: false, reason: 'status_final' });
  sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision, profile_hash,
    state, approved_at, expires_at, updated_at) VALUES ('s-done', ?, 'elsewhere', ?, 'lever', '', 1, '', 'submitted', ?, ?, ?)`)
    .run(OWNER, items.sent.jobKey, iso(NOW), iso(NOW), iso(NOW));
  assert.deepEqual(await deny('sent'), { ok: false, reason: 'already_submitted' });
  assert.deepEqual(await deny('page', NOW, { pageUrl: 'https://jobs.lever.co/beta/5a1b2c3d-1111-2222-3333-999999999999' }), { ok: false, reason: 'wrong_page' });
  await saveSettings(db, OWNER, settings({ allowInvisibleCaptcha: false }), NOW);
  assert.deepEqual(await deny('setting', NOW, { relaxations: ['invisible_captcha'] }), { ok: false, reason: 'setting_changed' });
  assert.equal((await deny('setting', NOW, { relaxations: ['optional_sensitive_blank'] })).ok, true);
  // The profile changed after approval: the old hash and the new one are both refused.
  const oldHash = items.phone.profileHash;
  sqlite.prepare("UPDATE profiles SET phone = '404-999-9999' WHERE owner_email = ?").run(OWNER);
  assert.deepEqual(await deny('phone', NOW, { profileHash: oldHash }), { ok: false, reason: 'profile_changed' });
  assert.deepEqual(await deny('phone', NOW, { profileHash: await currentHash(sqlite) }), { ok: false, reason: 'profile_changed' });
  assert.equal(state(sqlite, items.phone.approvalId), 'approved');
  assert.deepEqual(await claimSubmission(db, OWNER, { approvalId: 'nope' }, NOW), { ok: false, reason: 'invalid_request' });
  assert.ok(events(sqlite, items.revoked.approvalId).includes('claim_denied'));
  // Last, because the claim's sweep expires every approval past its 24 hours.
  assert.deepEqual(await deny('expired', NOW + 25 * HOUR, { profileHash: await currentHash(sqlite) }), { ok: false, reason: 'expired' });
  assert.equal(state(sqlite, items.expired.approvalId), 'expired');
});

test('automatic clicks need 3 of your own confirmed submissions, a daily cap and a minute apart', async () => {
  const { sqlite, db } = setup();
  for (let n = 1; n <= 4; n++) addApp(sqlite, `a${n}`, ghUrl(n));
  await assert.rejects(saveSettings(db, OWNER, settings({ auto: { greenhouse: true, lever: false, ashby: false } }), NOW),
    (error: unknown) => error instanceof UserFacingError && error.status === 400 && /0 so far/.test(error.message));
  calibrate(sqlite, 'greenhouse', 2);
  const first = await approveOne(db, 'a1');
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(first), NOW), { ok: true, mode: 'supervised' });
  calibrate(sqlite, 'greenhouse', 1);
  const saved = await saveSettings(db, OWNER, settings({ auto: { greenhouse: true, lever: false, ashby: false }, dailyCap: 2 }), NOW);
  assert.equal(saved.auto.greenhouse, true);
  assert.deepEqual(await loadSettings(db, OWNER), saved);
  assert.equal((await submissionsPage(db, OWNER, NOW)).calibration.greenhouse, 3);

  const [i2, i3, i4] = [await approveOne(db, 'a2'), await approveOne(db, 'a3'), await approveOne(db, 'a4')];
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(i2), NOW), { ok: true, mode: 'auto' });
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(i3), NOW + 10_000), { ok: false, reason: 'spacing', retryAfterSec: 50 });
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(i3), NOW + 61_000), { ok: true, mode: 'auto' });
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(i4), NOW + 5 * MIN), { ok: false, reason: 'daily_cap', resetAt: iso(NOW + 24 * HOUR) });
  assert.equal(state(sqlite, i4.approvalId), 'approved');
  // Lever has no calibration, so it stays supervised whatever the settings say.
  sqlite.prepare("UPDATE profiles SET apply_settings_json = ? WHERE owner_email = ?")
    .run(JSON.stringify(settings({ auto: { greenhouse: true, lever: true, ashby: false } })), OWNER);
  addApp(sqlite, 'lv', LEVER(1));
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(await approveOne(db, 'lv', NOW + 6 * MIN), {}), NOW + 6 * MIN), { ok: true, mode: 'supervised' });
});

test('default settings let invisible CAPTCHA markers and optional sensitive questions through', async () => {
  const { sqlite, db } = setup();
  assert.deepEqual(await loadSettings(db, OWNER), settings());
  addApp(sqlite, 'a1', ghUrl(1));
  const item = await approveOne(db, 'a1');
  const result = await claimSubmission(db, OWNER, claimOf(item, { relaxations: ['invisible_captcha', 'optional_sensitive_blank'] }), NOW);
  assert.deepEqual(result, { ok: true, mode: 'supervised' });
  assert.equal((sqlite.prepare('SELECT relaxations FROM submissions WHERE id = ?').get(item.approvalId) as { relaxations: string }).relaxations,
    'invisible_captcha,optional_sensitive_blank');
  await assert.rejects(saveSettings(db, OWNER, settings({ dailyCap: 26 }), NOW), UserFacingError);
});

test('results: duplicates are acked and applied once; stale attempts change nothing', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const item = await approveOne(db, 'a1');
  const attemptA = await claimed(db, item);
  const released = resultOf(item, attemptA, 'not_clicked');
  assert.deepEqual((await recordResults(db, OWNER, [released], NOW + MIN)).acked, [released.resultId]);
  assert.equal(state(sqlite, item.approvalId), 'approved');
  const attemptB = await claimed(db, item, NOW + 2 * MIN);
  const again = await recordResults(db, OWNER, [released], NOW + 3 * MIN);
  assert.deepEqual(again.acked, [released.resultId]);
  assert.equal(again.submissions[0].state, 'claimed');
  assert.equal(again.submissions[0].attemptId, attemptB);
  // A different result from the old attempt can't move the newer claim either.
  await recordResults(db, OWNER, [resultOf(item, attemptA, 'not_clicked'), resultOf(item, attemptA, 'check'),
    resultOf(item, attemptA, 'needs_you'), resultOf(item, attemptA, 'submitted')], NOW + 3 * MIN);
  assert.equal(state(sqlite, item.approvalId), 'claimed');
  assert.equal(appStatus(sqlite, 'a1'), 'saved');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM submission_events WHERE id = ?').get(released.resultId)!.n, 1);
  // Something clicked can never be released back to approved.
  const bad = await recordResults(db, OWNER, [resultOf(item, attemptB, 'not_clicked', { clicked: true })], NOW + 3 * MIN);
  assert.deepEqual(bad.acked, []);
  assert.equal(bad.rejected.length, 1);
  assert.equal(state(sqlite, item.approvalId), 'claimed');
  await assert.rejects(recordResults(db, OWNER, Array.from({ length: 21 }, () => released), NOW), UserFacingError);
});

test('results: a submission marks the application applied and revokes other approvals for the job', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const item = await approveOne(db, 'a1');
  const attempt = await claimed(db, item);
  const out = await recordResults(db, OWNER, [resultOf(item, attempt, 'submitted', {
    confirmationText: 'Thank you for applying. '.repeat(30), pageUrl: `${ghUrl(1)}/confirmation`,
  })], NOW + MIN);
  const row = out.submissions[0];
  assert.equal(row.state, 'submitted');
  assert.equal(row.clickedBy, 'applypilot');
  assert.equal(row.confirmationText.length, 300);
  assert.equal(row.pageUrl, `${ghUrl(1)}/confirmation`);
  assert.equal(appStatus(sqlite, 'a1'), 'applied');

  // Peter finished a needs-you tab himself after re-approving the same job from another card.
  addApp(sqlite, 'b1', ghUrl(2));
  addApp(sqlite, 'b2', ghUrl(2));
  const x = await approveOne(db, 'b1');
  const attemptX = await claimed(db, x);
  await recordResults(db, OWNER, [resultOf(x, attemptX, 'needs_you', { reasons: [{ code: 'demographic', text: 'A required demographic question' }] })], NOW + MIN);
  assert.equal(state(sqlite, x.approvalId), 'needs_you');
  assert.equal((sqlite.prepare('SELECT reason FROM submissions WHERE id = ?').get(x.approvalId) as { reason: string }).reason, 'A required demographic question');
  const y = await approveOne(db, 'b2', NOW + 2 * MIN);
  await recordResults(db, OWNER, [resultOf(x, attemptX, 'submitted', { clicked: false, clickedBy: 'you', pageUrl: 'https://evil.example/x' })], NOW + 3 * MIN);
  assert.equal(state(sqlite, x.approvalId), 'submitted');
  assert.equal((sqlite.prepare('SELECT page_url FROM submissions WHERE id = ?').get(x.approvalId) as { page_url: string }).page_url, '');
  assert.equal(state(sqlite, y.approvalId), 'revoked');
  assert.equal(appStatus(sqlite, 'b1'), 'applied');
  assert.deepEqual(events(sqlite, y.approvalId), ['approved', 'revoked']);
});

test('results: not_clicked releases the claim, or expires it when the approval ran out', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  addApp(sqlite, 'a2', ghUrl(2));
  const one = await approveOne(db, 'a1');
  const two = await approveOne(db, 'a2');
  const a1 = await claimed(db, one);
  const a2 = await claimed(db, two);
  await recordResults(db, OWNER, [resultOf(one, a1, 'not_clicked')], NOW + MIN);
  await recordResults(db, OWNER, [resultOf(two, a2, 'not_clicked')], NOW + 25 * HOUR);
  assert.equal(state(sqlite, one.approvalId), 'approved');
  assert.equal(state(sqlite, two.approvalId), 'expired');
  assert.deepEqual(events(sqlite, two.approvalId), ['approved', 'claimed', 'result:not_clicked', 'expired']);
  // Cancelled is recorded but moves nothing.
  await recordResults(db, OWNER, [resultOf(one, null, 'cancelled')], NOW + 2 * MIN);
  assert.equal(state(sqlite, one.approvalId), 'approved');
});

test('results: needs_you and check move a claim only for its own attempt', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  addApp(sqlite, 'a2', ghUrl(2));
  addApp(sqlite, 'a3', ghUrl(3));
  const pre = await approveOne(db, 'a3');
  await recordResults(db, OWNER, [resultOf(pre, null, 'needs_you', { reasons: [{ code: 'password_field', text: 'Asks for a password' }] })], NOW);
  assert.equal(state(sqlite, pre.approvalId), 'needs_you');
  const one = await approveOne(db, 'a1');
  const two = await approveOne(db, 'a2');
  const a1 = await claimed(db, one);
  const a2 = await claimed(db, two);
  await recordResults(db, OWNER, [resultOf(one, crypto.randomUUID(), 'needs_you'), resultOf(two, null, 'check')], NOW + MIN);
  assert.equal(state(sqlite, one.approvalId), 'claimed');
  assert.equal(state(sqlite, two.approvalId), 'claimed');
  // A needs_you that says ApplyPilot clicked is not a release.
  await recordResults(db, OWNER, [resultOf(one, a1, 'needs_you', { clicked: true, clickedBy: 'applypilot' })], NOW + MIN);
  assert.equal(state(sqlite, one.approvalId), 'claimed');
  await recordResults(db, OWNER, [resultOf(one, a1, 'needs_you'), resultOf(two, a2, 'check')], NOW + MIN);
  assert.equal(state(sqlite, one.approvalId), 'needs_you');
  assert.equal(state(sqlite, two.approvalId), 'check');
  assert.equal((sqlite.prepare('SELECT reason FROM submissions WHERE id = ?').get(two.approvalId) as { reason: string }).reason, 'Submit pressed, no confirmation seen');
});

test('results: a watched tab records your own submission from needs_you, revoked or check', async () => {
  const { sqlite, db } = setup();
  for (const id of ['n', 'r', 'c', 'x']) addApp(sqlite, id, ghUrl(id.charCodeAt(0)));
  const n = await approveOne(db, 'n');
  const r = await approveOne(db, 'r');
  const c = await approveOne(db, 'c');
  const x = await approveOne(db, 'x');
  await recordResults(db, OWNER, [resultOf(n, null, 'needs_you')], NOW);
  await cancelSubmissions(db, OWNER, [r.approvalId], NOW);
  const attempt = await claimed(db, c);
  await recordResults(db, OWNER, [resultOf(c, attempt, 'check')], NOW + MIN);
  const mine = (item: ApprovedItem) => resultOf(item, null, 'submitted', { clicked: false, clickedBy: 'you' });
  // Only Peter's own confirmed submission moves these; an ApplyPilot claim with no attempt does not.
  await recordResults(db, OWNER, [resultOf(n, null, 'submitted')], NOW + 2 * MIN);
  assert.equal(state(sqlite, n.approvalId), 'needs_you');
  await recordResults(db, OWNER, [mine(n), mine(r), mine(c), mine(x)], NOW + 2 * MIN);
  assert.equal(state(sqlite, n.approvalId), 'submitted');
  assert.equal(state(sqlite, r.approvalId), 'submitted');
  assert.equal(state(sqlite, c.approvalId), 'submitted');
  assert.equal(state(sqlite, x.approvalId), 'approved', 'an approval never jumps straight to submitted');
  assert.equal(appStatus(sqlite, 'r'), 'applied');
});

test('results: your own Submit click in a needs-you tab moves it to check and withdraws a newer approval of the job', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const first = await approveOne(db, 'a1');
  await recordResults(db, OWNER, [resultOf(first, null, 'needs_you')], NOW);
  const second = await approveOne(db, 'a1', NOW + MIN);
  const clickedBy = (who: string) => resultOf(first, null, 'check', { clicked: false, clickedBy: who, reasons: [{ code: 'you_clicked', text: 'You clicked Submit in the open tab.' }] });
  // Only your own click counts; nothing ApplyPilot reports without a claim moves a needs-you row.
  await recordResults(db, OWNER, [resultOf(first, null, 'check')], NOW + 2 * MIN);
  assert.equal(state(sqlite, first.approvalId), 'needs_you');
  await recordResults(db, OWNER, [clickedBy('you')], NOW + 2 * MIN);
  assert.equal(state(sqlite, first.approvalId), 'check');
  assert.equal(state(sqlite, second.approvalId), 'revoked');
  assert.equal((sqlite.prepare('SELECT clicked_by FROM submissions WHERE id = ?').get(first.approvalId) as { clicked_by: string }).clicked_by, 'you');
  const blocked = await approveForSubmit(db, OWNER, [{ applicationId: 'a1', revision: 1 }], { includeCoverLetter: true, now: NOW + 3 * MIN });
  assert.equal(blocked.skipped[0]?.code, 'in_progress');
  // "It didn't go through": the next approval replaces that one, so Chrome lets it past its record of your click.
  await resolveSubmission(db, OWNER, first.approvalId, 'not_sent', NOW + 4 * MIN);
  const third = await approveOne(db, 'a1', NOW + 5 * MIN);
  assert.equal(third.supersedesId, first.approvalId);
});

test('resolve works only on check rows or stale claims: 15 minutes, or 35 for a supervised claim waiting on your click', async () => {
  const { sqlite, db } = setup();
  for (const id of ['a', 'b', 'c']) addApp(sqlite, id, ghUrl(id.charCodeAt(0)));
  const a = await approveOne(db, 'a');
  const b = await approveOne(db, 'b');
  const c = await approveOne(db, 'c');
  await assert.rejects(resolveSubmission(db, OWNER, a.approvalId, 'submitted', NOW), (e: unknown) => e instanceof UserFacingError && e.status === 409);
  const attemptB = await claimed(db, b);
  await assert.rejects(resolveSubmission(db, OWNER, b.approvalId, 'not_sent', NOW + 5 * MIN), UserFacingError);
  // Chrome waits up to 30 minutes for your click on a supervised claim.
  await assert.rejects(resolveSubmission(db, OWNER, b.approvalId, 'not_sent', NOW + 20 * MIN), UserFacingError);
  const stale = await resolveSubmission(db, OWNER, b.approvalId, 'not_sent', NOW + 36 * MIN);
  assert.equal(stale?.state, 'not_sent');
  assert.equal(appStatus(sqlite, 'b'), 'saved');
  void attemptB;
  const attemptC = await claimed(db, c, NOW + MIN);
  await recordResults(db, OWNER, [resultOf(c, attemptC, 'check')], NOW + 2 * MIN);
  assert.equal((await resolveSubmission(db, OWNER, c.approvalId, 'submitted', NOW + 3 * MIN))?.state, 'submitted');
  assert.equal(appStatus(sqlite, 'c'), 'applied');
  await assert.rejects(resolveSubmission(db, OWNER, c.approvalId, 'not_sent', NOW + 4 * MIN), UserFacingError);
  assert.ok(events(sqlite, c.approvalId).includes('resolved:submitted'));
  // "It didn't go through" lets you approve again; the new approval names the one it supersedes.
  const again = await approveOne(db, 'b', NOW + 40 * MIN);
  assert.equal(again.supersedesId, b.approvalId);
});

test('an automatic claim goes stale after 15 minutes', async () => {
  const { sqlite, db } = setup();
  calibrate(sqlite, 'greenhouse');
  await saveSettings(db, OWNER, settings({ auto: { greenhouse: true, lever: false, ashby: false } }), NOW);
  addApp(sqlite, 'a', ghUrl(1));
  const a = await approveOne(db, 'a');
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(a), NOW), { ok: true, mode: 'auto' });
  assert.equal((await resolveSubmission(db, OWNER, a.approvalId, 'not_sent', NOW + 16 * MIN))?.state, 'not_sent');
});

test('a late submitted result from ApplyPilot\'s click wins over "It didn\'t go through" and revokes the re-approval', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const first = await approveOne(db, 'a');
  const attempt = await claimed(db, first);
  await resolveSubmission(db, OWNER, first.approvalId, 'not_sent', NOW + 36 * MIN);
  const again = await approveOne(db, 'a', NOW + 37 * MIN);
  assert.equal(again.supersedesId, first.approvalId);
  await recordResults(db, OWNER, [resultOf(first, attempt, 'submitted')], NOW + 38 * MIN);
  assert.equal(state(sqlite, first.approvalId), 'submitted');
  assert.equal(state(sqlite, again.approvalId), 'revoked');
  assert.equal(appStatus(sqlite, 'a'), 'applied');
  // Never from another attempt.
  addApp(sqlite, 'b', ghUrl(2));
  const b = await approveOne(db, 'b');
  await claimed(db, b);
  await resolveSubmission(db, OWNER, b.approvalId, 'not_sent', NOW + 36 * MIN);
  await recordResults(db, OWNER, [resultOf(b, crypto.randomUUID(), 'submitted')], NOW + 38 * MIN);
  assert.equal(state(sqlite, b.approvalId), 'not_sent');
});

test('a check row whose page confirms later becomes submitted, clicked by ApplyPilot', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const attempt = await claimed(db, item);
  await recordResults(db, OWNER, [resultOf(item, attempt, 'check')], NOW + MIN);
  assert.equal(state(sqlite, item.approvalId), 'check');
  const out = await recordResults(db, OWNER, [resultOf(item, attempt, 'submitted', { confirmationText: 'Thanks for applying' })], NOW + 5 * MIN);
  assert.equal(out.submissions[0].state, 'submitted');
  assert.equal(out.submissions[0].clickedBy, 'applypilot');
  assert.equal(appStatus(sqlite, 'a'), 'applied');
});

test('the same claim sent twice (Chrome tried another dashboard tab) gets the same answer; a released attempt never claims again', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const req = claimOf(item);
  assert.deepEqual(await claimSubmission(db, OWNER, req, NOW), { ok: true, mode: 'supervised' });
  assert.deepEqual(await claimSubmission(db, OWNER, req, NOW + 1000), { ok: true, mode: 'supervised' });
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed']);
  // Chrome gave that attempt back; a copy of its claim that arrives late is refused.
  await recordResults(db, OWNER, [resultOf(item, req.attemptId, 'not_clicked')], NOW + MIN);
  assert.equal(state(sqlite, item.approvalId), 'approved');
  const late: ClaimResult = await claimSubmission(db, OWNER, req, NOW + 2 * MIN);
  assert.deepEqual(late, { ok: false, reason: 'attempt_closed' });
  assert.equal(state(sqlite, item.approvalId), 'approved');
  assert.equal((await claimSubmission(db, OWNER, claimOf(item), NOW + 3 * MIN)).ok, true, 'a new attempt may claim it');
});

test('the same claim racing itself (both copies read before either writes) is granted to both, with one claimed event', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const req = claimOf(item);
  // The first copy's write waits until the second copy has read the row as approved.
  let readSecond!: () => void;
  const secondRead = new Promise<void>((r) => (readSecond = r));
  const db1 = { ...db, batch: async (s: never) => { await secondRead; return db.batch(s); } };
  const first = claimSubmission(db1 as never, OWNER, req, NOW);
  const db2 = { ...db, batch: async (s: never) => { readSecond(); await first; return db.batch(s); } };
  const second = claimSubmission(db2 as never, OWNER, req, NOW + 50);
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true, mode: 'supervised' }, { ok: true, mode: 'supervised' }]);
  assert.equal(state(sqlite, item.approvalId), 'claimed');
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed']);
  // A different attempt in the same race is still refused.
  addApp(sqlite, 'b', ghUrl(2));
  const b = await approveOne(db, 'b');
  const [one, other] = [claimOf(b), claimOf(b)];
  let readOther!: () => void;
  const otherRead = new Promise<void>((r) => (readOther = r));
  const dbA = { ...db, batch: async (s: never) => { await otherRead; return db.batch(s); } };
  const winner = claimSubmission(dbA as never, OWNER, one, NOW);
  const dbB = { ...db, batch: async (s: never) => { readOther(); await winner; return db.batch(s); } };
  const loser = claimSubmission(dbB as never, OWNER, other, NOW + 50);
  assert.deepEqual(await Promise.all([winner, loser]), [{ ok: true, mode: 'supervised' }, { ok: false, reason: 'already_claimed' }]);
});

test('"Stop everything" while a claim commits between its read and its write: the claim given back comes back cancelled', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const req = claimOf(item);
  let granted: ClaimResult | undefined;
  // cancel has read the row as approved; Chrome's claim commits before cancel's batch runs.
  const racing = { ...db, batch: async (s: never) => { granted = await claimSubmission(db, OWNER, req, NOW + 10); return db.batch(s); } };
  assert.deepEqual(await cancelSubmissions(racing as never, OWNER, 'all', NOW + 20), { revoked: [], tooLate: [item.approvalId] });
  assert.deepEqual(granted, { ok: true, mode: 'supervised' });
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed', 'cancel_requested']);
  await recordResults(db, OWNER, [resultOf(item, req.attemptId, 'not_clicked')], NOW + 2000);
  assert.equal(state(sqlite, item.approvalId), 'revoked');
  assert.deepEqual(await claimSubmission(db, OWNER, claimOf(item), NOW + 10 * MIN), { ok: false, reason: 'revoked' });
});

test('"Stop everything" during a claim: when Chrome gives the claim back, it comes back cancelled', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const attempt = await claimed(db, item);
  assert.deepEqual(await cancelSubmissions(db, OWNER, 'all', NOW + 1000), { revoked: [], tooLate: [item.approvalId] });
  await recordResults(db, OWNER, [resultOf(item, attempt, 'not_clicked')], NOW + 2000);
  assert.equal(state(sqlite, item.approvalId), 'revoked');
  assert.equal((sqlite.prepare('SELECT reason FROM submissions WHERE id = ?').get(item.approvalId) as { reason: string }).reason, 'Cancelled by you');
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed', 'cancel_requested', 'result:not_clicked', 'revoked']);
  assert.equal((await claimSubmission(db, OWNER, claimOf(item), NOW + MIN)).ok, false);
  // A claim that wasn't cancelled is still released back to approved.
  addApp(sqlite, 'b', ghUrl(2));
  const b = await approveOne(db, 'b');
  const attemptB = await claimed(db, b, NOW + MIN);
  await recordResults(db, OWNER, [resultOf(b, attemptB, 'not_clicked')], NOW + 2 * MIN);
  assert.equal(state(sqlite, b.approvalId), 'approved');
});

test('calibration counts only supervised claims confirmed straight from your click on the form ApplyPilot checked', async () => {
  const { sqlite, db } = setup();
  for (const id of ['ok', 'unknown', 'changed', 'resolved', 'by-hand']) addApp(sqlite, id, LEVER(id.length + id.charCodeAt(0)));
  const mine = (item: ApprovedItem, attemptId: string | null, extra: Record<string, unknown> = {}) =>
    resultOf(item, attemptId, 'submitted', { clicked: false, clickedBy: 'you', ...extra });
  const ok = await approveOne(db, 'ok');
  await recordResults(db, OWNER, [mine(ok, await claimed(db, ok), { fingerprintMatched: true })], NOW + MIN);
  assert.deepEqual(await calibration(db), { greenhouse: 0, lever: 1, ashby: 0 });
  // Confirmed while ApplyPilot watched, without a click it could compare: still counts.
  const unknown = await approveOne(db, 'unknown');
  await recordResults(db, OWNER, [mine(unknown, await claimed(db, unknown))], NOW + MIN);
  assert.equal((await calibration(db)).lever, 2);
  // The form changed before your click.
  const changed = await approveOne(db, 'changed');
  await recordResults(db, OWNER, [mine(changed, await claimed(db, changed), { fingerprintMatched: false })], NOW + MIN);
  // You said "It went through" on a check row.
  const resolved = await approveOne(db, 'resolved');
  const attemptR = await claimed(db, resolved);
  await recordResults(db, OWNER, [resultOf(resolved, attemptR, 'check', { clickedBy: 'you', clicked: false })], NOW + MIN);
  await resolveSubmission(db, OWNER, resolved.approvalId, 'submitted', NOW + 2 * MIN);
  // A needs-you tab you finished by hand.
  const byHand = await approveOne(db, 'by-hand');
  const attemptH = await claimed(db, byHand);
  await recordResults(db, OWNER, [resultOf(byHand, attemptH, 'needs_you')], NOW + MIN);
  await recordResults(db, OWNER, [mine(byHand, attemptH)], NOW + 2 * MIN);
  for (const item of [changed, resolved, byHand]) assert.equal(state(sqlite, item.approvalId), 'submitted');
  assert.deepEqual(await calibration(db), { greenhouse: 0, lever: 2, ashby: 0 });
});

test('results for an approval this account does not own are left in Chrome, not acked', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a', ghUrl(1));
  const item = await approveOne(db, 'a');
  const attempt = await claimed(db, item);
  const result = resultOf(item, attempt, 'submitted');
  const wrong = await recordResults(db, OTHER, [result], NOW + MIN);
  assert.deepEqual(wrong.acked, []);
  assert.deepEqual(wrong.notYours, [result.resultId]);
  assert.equal(state(sqlite, item.approvalId), 'claimed');
  const right = await recordResults(db, OWNER, [result], NOW + 2 * MIN);
  assert.deepEqual(right.acked, [result.resultId]);
  assert.equal(state(sqlite, item.approvalId), 'submitted');
});

test('cancel revokes approvals not yet claimed and reports claimed ones as too late', async () => {
  const { sqlite, db } = setup();
  for (const id of ['a', 'b', 'c']) addApp(sqlite, id, ghUrl(id.charCodeAt(0)));
  const a = await approveOne(db, 'a');
  const b = await approveOne(db, 'b');
  const c = await approveOne(db, 'c');
  await claimed(db, b);
  assert.deepEqual(await cancelSubmissions(db, OWNER, [a.approvalId, b.approvalId, 'junk'], NOW), { revoked: [a.approvalId], tooLate: [b.approvalId] });
  assert.equal((sqlite.prepare('SELECT reason FROM submissions WHERE id = ?').get(a.approvalId) as { reason: string }).reason, 'Cancelled by you');
  assert.deepEqual(await cancelSubmissions(db, OWNER, 'all', NOW), { revoked: [c.approvalId], tooLate: [b.approvalId] });
});

test('the list shows live and recent rows with targets, settings and calibration', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  addApp(sqlite, 'site', 'https://acme.com/jobs/1');
  addApp(sqlite, 'done', ghUrl(3), { status: 'applied' });
  const item = await approveOne(db, 'a1');
  const page = await submissionsPage(db, OWNER, NOW);
  assert.deepEqual(Object.keys(page.targets).sort(), ['a1', 'site']);
  assert.deepEqual(page.targets.site, { reason: 'Company site, not Greenhouse, Lever or Ashby: apply yourself' });
  assert.deepEqual(page.settings, settings());
  assert.deepEqual(page.calibration, { greenhouse: 0, lever: 0, ashby: 0 });
  assert.equal(page.submissions.length, 1);
  assert.equal(page.submissions[0].fillReport, undefined);
  await claimed(db, item);
  const one = await listSubmissions(db, OWNER, NOW, { id: item.approvalId });
  assert.equal(one.submissions[0].fillReport?.[0].value, 'Peter');
  // Old finished rows drop off after 30 days; live ones never do.
  sqlite.prepare("UPDATE submissions SET state = 'revoked', updated_at = ? WHERE id = ?").run(iso(NOW - 31 * 86_400_000), item.approvalId);
  assert.equal((await listSubmissions(db, OWNER, NOW)).submissions.length, 0);
});

test('events are append-only and outlive a deleted application', async () => {
  const { sqlite, db } = setup();
  addApp(sqlite, 'a1', ghUrl(1));
  const item = await approveOne(db, 'a1');
  const attempt = await claimed(db, item);
  const before = sqlite.prepare('SELECT * FROM submission_events ORDER BY rowid').all();
  await recordResults(db, OWNER, [resultOf(item, attempt, 'submitted')], NOW + MIN);
  await claimSubmission(db, OWNER, claimOf(item), NOW + 2 * MIN);
  const after = sqlite.prepare('SELECT * FROM submission_events ORDER BY rowid').all();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.length > before.length);
  sqlite.prepare("DELETE FROM applications WHERE id = 'a1'").run();
  assert.equal(state(sqlite, item.approvalId), 'submitted');
  assert.deepEqual(events(sqlite, item.approvalId), ['approved', 'claimed', 'result:submitted', 'claim_denied']);
});
