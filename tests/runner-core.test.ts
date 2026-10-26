import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  KEYS, acceptBatch, ackResults, cancelJobs, cleanup, createRunner, focusJobTab, forgetTabs, heldSummary, pullResults, validateJob,
} from '../extension/runner-core.js';

// Fakes are loosely typed on purpose: they stand in for chrome.* objects.
type Json = ReturnType<typeof JSON.parse>;

const T0 = Date.parse('2026-10-26T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Title (Test Person Resume) >> endobj\n%%EOF\n');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const sha256 = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const clone = (v: unknown): Json => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

function makeJob(over: Json = {}): Json {
  const leverId = randomUUID();
  return {
    approvalId: randomUUID(), applicationId: `app-${leverId.slice(0, 8)}`, jobKey: `lever:acme:${leverId}`, ats: 'lever',
    applyUrls: [`https://jobs.lever.co/acme/${leverId}/apply`], company: 'Acme Health', role: 'Help Desk Technician', revision: 2,
    approvedAt: iso(T0 - 60_000), expiresAt: iso(T0 + 23 * HOUR), supersedesId: null,
    profile: { firstName: 'Test', lastName: 'Person', email: 't@example.com', phone: '404-555-0100' }, profileHash: 'a'.repeat(64),
    resume: { name: 'Test_Person_Resume.pdf', type: 'application/pdf', size: PDF.length, sha256: PDF_SHA, b64: PDF.toString('base64') },
    coverLetter: 'Dear team,', ...over,
  };
}

function fakeEvent() {
  const fns = new Set<(...a: Json[]) => void>();
  return { addListener: (f: (...a: Json[]) => void) => fns.add(f), removeListener: (f: (...a: Json[]) => void) => fns.delete(f), emit: (...a: Json[]) => [...fns].forEach((f) => f(...a)) };
}

function fakeStorage(seed: Json = {}) {
  const data = new Map<string, Json>(Object.entries(clone(seed)));
  const s = {
    data,
    beforeSet: null as null | ((items: Json) => Promise<void> | void),
    async get(keys: Json) {
      if (keys == null) return clone(Object.fromEntries(data));
      const out: Json = {};
      for (const k of [].concat(keys)) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items: Json) {
      if (s.beforeSet) await s.beforeSet(items);
      for (const [k, v] of Object.entries(clone(items))) data.set(k, v);
    },
    async remove(keys: Json) {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
  return s;
}

function fakeTabs() {
  let next = 100;
  const open = new Map<number, Json>();
  const onUpdated = fakeEvent();
  const onRemoved = fakeEvent();
  const created: string[] = [];
  const removed: number[] = [];
  const t = {
    open, created, removed, onUpdated, onRemoved,
    landOn: (url: string) => url,
    async create(p: Json) {
      const id = next++;
      created.push(p.url);
      open.set(id, { id, url: t.landOn(p.url), status: 'complete', windowId: 1 });
      return { id, status: 'loading', windowId: 1 };
    },
    async get(id: number) {
      if (!open.has(id)) throw new Error('No tab with id');
      return { ...open.get(id) };
    },
    async update(id: number) {
      if (!open.has(id)) throw new Error('No tab with id');
      return { ...open.get(id) };
    },
    async remove(id: number) {
      removed.push(id);
      if (open.delete(id)) onRemoved.emit(id);
    },
  };
  return t;
}

function fakePage(tabs: ReturnType<typeof fakeTabs>) {
  const calls: string[] = [];
  const thanks = (tabId: number) => String(tabs.open.get(tabId)?.url ?? '').replace(/\/apply$/, '/thanks');
  const handlers: Record<string, (arg: Json, tabId: number) => Json> = {
    findForm: () => ({ ok: true, reason: '', text: '', rootPath: 'form#application-form', inIframe: false, multiStep: false }),
    fill: () => ({ filled: [{ label: 'Email', type: 'email', required: true, value: 't@example.com', source: 'profile' }], blockers: [], resumeInputPath: '#resume' }),
    audit: () => ({
      fingerprint: 'fp-1', blockers: [], relaxations: [], submit: { path: '#btn-submit', label: 'Submit application' },
      report: [{ label: 'Email', type: 'email', required: true, value: 't@example.com', source: 'profile' }],
    }),
    pressSubmit: () => ({ clicked: true }),
    armSupervised: () => ({ armed: true, reason: '', submit: { path: '#btn-submit', label: 'Submit application' } }),
    readOutcome: (_a, tabId) => ({ outcome: 'submitted', code: 'confirmed', reason: '', confirmationText: 'Thank you for applying.', url: thanks(tabId), confirmationKind: 'url' }),
    watchForConfirmation: () => ({ watching: true }),
    bannerNeedsYou: (reasons) => ({ shown: true, count: reasons.length }),
  };
  return {
    calls, handlers,
    async executeScript({ target, files, args }: Json) {
      if (files) {
        if (!tabs.open.has(target.tabId)) throw new Error('No tab with id');
        calls.push('inject');
        return [{ result: null }];
      }
      const [method, params] = args;
      calls.push(method);
      const h = handlers[method];
      return [{ result: h ? await h(params[0], target.tabId) : { __apMissing: true } }];
    },
  };
}

type Setup = {
  jobs?: Json[]; claims?: Json[]; settings?: Json; seed?: Json; hang?: (ms: number) => boolean; autoAck?: boolean; permitted?: boolean;
  countdownMs?: number; deps?: Json;
};

async function setup(o: Setup = {}) {
  const storage = fakeStorage(o.seed ?? {});
  const tabs = fakeTabs();
  const scripting = fakePage(tabs);
  let clock = T0;
  const slept: number[] = [];
  const hang = o.hang ?? (() => false);
  const claims = [...(o.claims ?? [{ ok: true, mode: 'auto' }])];
  const delivered: Json[] = [];
  const bridge = {
    sent: [] as Json[],
    notes: [] as Json[],
    async claim(p: Json) {
      bridge.sent.push(clone(p));
      const next = claims.length > 1 ? claims.shift() : claims[0];
      return typeof next === 'function' ? next(p) : clone(next);
    },
    async notify(type: string, payload: Json) {
      bridge.notes.push([type, payload]);
      // Stands in for the dashboard: pull, "POST", then ack.
      if (type === 'AP_RESULTS_WAITING' && o.autoAck) {
        const results = await pullResults(storage);
        delivered.push(...results);
        await ackResults(storage, results.map((r: Json) => r.resultId), clock);
      }
    },
  };
  const deps = {
    storage, tabs, scripting, bridge, sha256, uuid: randomUUID,
    windows: { update: async () => ({}) },
    permissions: { contains: async () => o.permitted ?? true },
    now: () => clock,
    sleep: (ms: number) => {
      slept.push(ms);
      return hang(ms) ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, 1));
    },
    ...(o.deps ?? {}),
  };
  const settings = o.settings ?? { auto: { lever: true } };
  const jobs = o.jobs ?? [makeJob()];
  if (jobs.length) {
    const res = await acceptBatch(storage, { batchId: 'b1', createdAt: iso(T0), settings, jobs }, { now: T0, sha256 });
    assert.deepEqual(res.rejected, []);
  }
  const make = () => createRunner(deps, { countdownMs: o.countdownMs ?? 0, windowId: 1, version: '3.0.0' });
  const runner = make();
  return {
    storage, tabs, scripting, bridge, runner, make, slept, delivered, jobs,
    advance: (ms: number) => (clock += ms),
    results: () => pullResults(storage),
    job: (id: string) => storage.data.get(KEYS.job(id)),
    patchJob: (id: string, patch: Json) => storage.data.set(KEYS.job(id), { ...storage.data.get(KEYS.job(id)), ...patch }),
  };
}

const pageCalls = (s: { scripting: { calls: string[] } }, name: string) => s.scripting.calls.filter((c) => c === name).length;

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- auto mode -----------------------------------------------------------------------------------

test('the ledger write is awaited before pressSubmit, then the job is reported submitted', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const order: string[] = [];
  s.storage.beforeSet = async (items) => {
    if (Object.keys(items).some((k) => k.startsWith('apLedger:'))) {
      order.push('ledger:start');
      await tick(20);
      order.push('ledger:done');
    }
  };
  s.scripting.handlers.pressSubmit = () => (order.push('pressSubmit'), { clicked: true });
  await s.runner.recover();
  await s.runner.run({ countdown: false });

  assert.deepEqual(order.slice(0, 3), ['ledger:start', 'ledger:done', 'pressSubmit']);
  const [claim] = s.bridge.sent;
  assert.equal(claim.approvalId, job.approvalId);
  assert.equal(claim.resumeSha256, PDF_SHA);
  assert.equal(claim.resumeFilename, 'Test_Person_Resume.pdf');
  assert.equal(claim.pageUrl, job.applyUrls[0]);
  assert.equal(claim.fingerprint, 'fp-1');
  assert.deepEqual(claim.relaxations, []);
  assert.equal(claim.extensionVersion, '3.0.0');
  const ledger = s.storage.data.get(KEYS.ledger(job.jobKey));
  assert.equal(ledger.approvalId, job.approvalId);
  assert.equal(ledger.attemptId, claim.attemptId);
  assert.equal(ledger.mode, 'auto');
  assert.equal(ledger.outcome, 'submitted');
  const [r] = await s.results();
  assert.equal(r.outcome, 'submitted');
  assert.equal(r.fingerprintMatched, null, 'ApplyPilot clicked, so there was no click of yours to compare');
  assert.equal(r.clicked, true);
  assert.equal(r.clickedBy, 'applypilot');
  assert.equal(r.attemptId, claim.attemptId);
  assert.match(r.pageUrl, /\/thanks$/);
  assert.equal(pageCalls(s, 'pressSubmit'), 1);
  const rec = s.job(job.approvalId);
  assert.equal(rec.state, 'done:submitted');
  assert.equal(rec.job.resume.b64, undefined, 'the PDF is deleted once the job is finished');
  assert.ok(s.bridge.notes.some(([type]: Json) => type === 'AP_RESULTS_WAITING'));
});

test('a denied claim never reaches pressSubmit', async () => {
  const s = await setup({ claims: [{ ok: false, reason: 'resume_changed' }] });
  const [job] = s.jobs;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  assert.equal(pageCalls(s, 'armSupervised'), 0);
  assert.equal(s.storage.data.has(KEYS.ledger(job.jobKey)), false);
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.clicked, false);
  assert.equal(r.attemptId, null, 'a denied claim holds nothing on the server');
  assert.deepEqual(r.reasons.map((x: Json) => x.code), ['resume_changed']);
  assert.equal(pageCalls(s, 'bannerNeedsYou'), 1);
  assert.equal(s.storage.data.has(KEYS.watch(s.job(job.approvalId).tabId)), true, 'the tab stays open and watched');
});

test('a revoked approval is cancelled, nothing clicked, and its tab closed', async () => {
  const s = await setup({ claims: [{ ok: false, reason: 'revoked' }] });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'cancelled');
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  assert.equal(s.tabs.open.size, 0);
});

test('Stop pressed between the claim and the ledger write gives the claim back without a click', async () => {
  const s = await setup({
    claims: [() => {
      s.storage.data.set(KEYS.halt, true);
      return { ok: true, mode: 'auto' };
    }],
  });
  const [job] = s.jobs;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  assert.equal(s.storage.data.has(KEYS.ledger(job.jobKey)), false);
  const [r] = await s.results();
  assert.equal(r.outcome, 'not_clicked');
  assert.equal(r.clicked, false);
  assert.equal(r.clickedBy, '');
  assert.equal(r.attemptId, s.bridge.sent[0].attemptId);
  assert.equal(s.storage.data.get(KEYS.run).state, 'paused');
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'halted');
  assert.equal(s.job(job.approvalId).state, 'paused');
});

test('pressSubmit refusing ({clicked:false}) removes the ledger entry and reports needs_you', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.pressSubmit = () => ({ clicked: false, reason: 'fingerprint_changed', text: 'The form changed after ApplyPilot checked it.' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.storage.data.has(KEYS.ledger(job.jobKey)), false);
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.clicked, false);
  assert.equal(r.attemptId, s.bridge.sent[0].attemptId, 'the server moves the claimed row to needs_you');
  assert.deepEqual(r.reasons.map((x: Json) => x.code), ['fingerprint_changed']);
});

test('a rejected executeScript around the click counts as clicked: check, ledger kept, never retried', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.pressSubmit = () => {
    throw new Error('Frame with ID 0 was removed.');
  };
  s.scripting.handlers.readOutcome = () => ({ outcome: 'check', code: 'no_confirmation', reason: 'Submit pressed, no confirmation seen', url: '' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'check');
  assert.equal(r.clicked, true);
  assert.equal(r.clickedBy, 'applypilot');
  assert.ok(s.storage.data.has(KEYS.ledger(job.jobKey)));
  await s.runner.run({ countdown: false });
  assert.equal(pageCalls(s, 'pressSubmit'), 1);
});

// ---- crash recovery ------------------------------------------------------------------------------

test('a crash after the ledger write becomes check on recovery and is never clicked again', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const tab = await s.tabs.create({ url: job.applyUrls[0] });
  const attemptId = randomUUID();
  s.patchJob(job.approvalId, { state: 'submitting', tabId: tab.id, attemptId, claim: { mode: 'auto' } });
  s.storage.data.set(KEYS.ledger(job.jobKey), { clickedAt: iso(T0), approvalId: job.approvalId, applicationId: job.applicationId, attemptId, mode: 'auto' });
  const runner = s.make();
  await runner.recover();
  const [r] = await s.results();
  assert.equal(r.outcome, 'check');
  assert.equal(r.clicked, true);
  assert.equal(r.attemptId, attemptId);
  assert.match(r.reasons[0].text, /Chrome closed while submitting/);
  await runner.run({ countdown: false });
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  assert.equal(s.bridge.sent.length, 0);
  assert.ok(s.storage.data.has(KEYS.ledger(job.jobKey)));
  // A fresh approval for the same job is refused while the ledger says it was clicked.
  const again = await acceptBatch(s.storage, { jobs: [{ ...makeJob(), jobKey: job.jobKey, applyUrls: job.applyUrls }] }, { now: T0, sha256 });
  assert.equal(again.accepted.length, 0);
  assert.match(again.rejected[0].reason, /already pressed Submit/);
});

test('a crash while claiming reports not_clicked for that attempt, then the job runs again', async () => {
  const s = await setup({ autoAck: true });
  const [job] = s.jobs;
  const attemptId = randomUUID();
  s.patchJob(job.approvalId, { state: 'claiming', attemptId });
  const runner = s.make();
  await runner.recover();
  assert.equal(s.delivered[0].outcome, 'not_clicked');
  assert.equal(s.delivered[0].attemptId, attemptId);
  assert.equal(s.job(job.approvalId).state, 'queued');
  await runner.run({ countdown: false });
  assert.notEqual(s.bridge.sent[0].attemptId, attemptId);
  assert.equal(s.delivered.at(-1).outcome, 'submitted');
});

test('a new claim waits until the earlier release has reached the server', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.patchJob(job.approvalId, { state: 'claiming', attemptId: randomUUID() });
  const runner = s.make();
  await runner.recover();
  await runner.run({ countdown: false });
  assert.equal(s.bridge.sent.length, 0, 'no claim while the not_clicked result is unacknowledged');
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'dashboard');
  assert.equal(s.job(job.approvalId).state, 'paused');
});

test('a crash before the claim requeues the job and closes its half-filled tab', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const tab = await s.tabs.create({ url: job.applyUrls[0] });
  s.patchJob(job.approvalId, { state: 'auditing', tabId: tab.id });
  const runner = s.make();
  await runner.recover();
  assert.equal(s.job(job.approvalId).state, 'queued');
  assert.equal(s.tabs.open.has(tab.id), false);
  assert.deepEqual(await s.results(), []);
});

// ---- claim denials -------------------------------------------------------------------------------

test('spacing denials are waited out and retried; the next auto claim waits a minute', async () => {
  const s = await setup({
    jobs: [makeJob(), makeJob({ approvedAt: iso(T0 - 30_000) })],
    claims: [{ ok: false, reason: 'spacing', retryAfterSec: 7 }, { ok: true, mode: 'auto' }],
  });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.ok(s.slept.includes(7000));
  assert.ok(s.slept.includes(60_000), 'the second auto claim waits for 60 s after the first');
  assert.equal(s.bridge.sent.length, 3);
  assert.notEqual(s.bridge.sent[0].attemptId, s.bridge.sent[1].attemptId);
  const results = await s.results();
  assert.deepEqual(results.map((r: Json) => r.outcome), ['submitted', 'submitted']);
  assert.equal(results[0].attemptId, s.bridge.sent[1].attemptId);
});

test('the daily cap pauses the queue until it resets, with nothing clicked', async () => {
  const resetAt = iso(T0 + 3 * HOUR);
  const s = await setup({ claims: [{ ok: false, reason: 'daily_cap', resetAt }] });
  const [job] = s.jobs;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const run = s.storage.data.get(KEYS.run);
  assert.equal(run.state, 'paused');
  assert.equal(run.pausedReason, 'daily_cap');
  assert.equal(run.resumeAt, Date.parse(resetAt));
  assert.equal(s.job(job.approvalId).state, 'paused');
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  assert.equal(s.tabs.open.size, 0, 'the filled tab is closed; it is filled again after the reset');
  assert.deepEqual(await s.results(), []);
});

test('a daily-cap pause survives a runner restart until it resets', async () => {
  const s = await setup({ seed: { [KEYS.run]: { state: 'paused', pausedReason: 'daily_cap', resumeAt: T0 + HOUR } } });
  await s.runner.recover();
  await s.runner.start();
  assert.equal(s.storage.data.get(KEYS.run).state, 'paused');
  assert.equal(s.tabs.created.length, 0);
  s.advance(2 * HOUR);
  const later = s.make();
  await later.recover();
  await later.start();
  assert.equal(s.bridge.sent.length, 1, 'after the reset the queue runs again');
});

test('Stop pressed during a daily-cap pause holds: the reset timer never starts sending again', async () => {
  const resetAt = iso(T0 + 3 * HOUR);
  const s = await setup({ claims: [{ ok: false, reason: 'daily_cap', resetAt }, { ok: true, mode: 'auto' }] });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'daily_cap');
  await s.runner.stop();
  const run = s.storage.data.get(KEYS.run);
  assert.deepEqual([run.state, run.pausedReason, run.resumeAt], ['paused', 'halted', null]);
  s.advance(4 * HOUR);
  await s.runner.resumeAfterWait();
  assert.equal(s.bridge.sent.length, 1, 'no claim after the reset while Stop is on');
  assert.equal(s.storage.data.get(KEYS.halt), true);
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
});

test('a daily-cap answer to a claim made just before Stop is a Stop pause, with no reset time', async () => {
  const s = await setup({
    claims: [() => {
      s.storage.data.set(KEYS.halt, true);
      return { ok: false, reason: 'daily_cap', resetAt: iso(T0 + HOUR) };
    }],
  });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const run = s.storage.data.get(KEYS.run);
  assert.deepEqual([run.pausedReason, run.resumeAt], ['halted', null]);
});

test('the reset timer resumes a daily-cap pause once it is due, and not before', async () => {
  const s = await setup({ claims: [{ ok: false, reason: 'daily_cap', resetAt: iso(T0 + HOUR) }, { ok: true, mode: 'auto' }] });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  await s.runner.resumeAfterWait();
  assert.equal(s.bridge.sent.length, 1, 'too early');
  s.advance(HOUR);
  await s.runner.resumeAfterWait();
  assert.equal(s.bridge.sent.length, 2);
  assert.equal((await s.results())[0].outcome, 'submitted');
});

test('no dashboard to claim through pauses the run without a click, and gives the claim back in case it was granted', async () => {
  const s = await setup({ claims: [{ ok: false, reason: 'no_dashboard' }] });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'dashboard');
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  // The dashboard tab can reload after the server granted the claim but before its reply came back.
  const results = await s.results();
  assert.deepEqual(results.map((r: Json) => [r.outcome, r.clicked, r.attemptId]), [['not_clicked', false, s.bridge.sent[0].attemptId]]);
});

test('"Resume sending" restarts a run you paused in its countdown', async () => {
  const s = await setup({ countdownMs: 3000 });
  await s.runner.recover();
  const running = s.runner.run();
  s.runner.pauseCountdown();
  await running;
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'countdown');
  assert.equal(s.bridge.sent.length, 0);
  // apHalt was already false, so only the dashboard's resume can start it again.
  await s.runner.onResumeAsked();
  assert.equal((await s.results())[0]?.outcome, 'submitted');
});

test('"Resume sending" on an idle runner keeps the countdown before the first job', async () => {
  const s = await setup({ countdownMs: 3000, hang: (ms) => ms === 1000 });
  await s.runner.recover();
  void s.runner.onResumeAsked();
  await until(() => s.runner.view().countdown > 0, 'the countdown');
  await tick(20);
  assert.equal(s.bridge.sent.length, 0);
  assert.equal(pageCalls(s, 'fill'), 0);
});

// ---- supervised mode -----------------------------------------------------------------------------

const supervisedHang = (ms: number) => ms >= 25 * 60_000;

test('supervised: ApplyPilot highlights Submit, waits for your click, and records it as yours', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  s.scripting.handlers.armSupervised = (_fp, tabId) => {
    setTimeout(() => s.runner.onPageEvent({ type: 'AP_PAGE_EVENT', kind: 'peter_click', url: job.applyUrls[0] },
      { id: 'ext', tab: { id: tabId }, url: job.applyUrls[0] }), 5);
    return { armed: true, reason: '' };
  };
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  // Your submission is in the ledger too, so a re-approval can't be clicked while this result is on its way.
  const ledger = s.storage.data.get(KEYS.ledger(job.jobKey));
  assert.deepEqual([ledger.approvalId, ledger.mode, ledger.outcome], [job.approvalId, 'you', 'submitted']);
  const [r] = await s.results();
  assert.equal(r.outcome, 'submitted');
  assert.equal(r.clicked, false);
  assert.equal(r.clickedBy, 'you');
  assert.equal(r.attemptId, s.bridge.sent[0].attemptId);
  assert.equal(r.fingerprintMatched, false, 'the page did not say the form at your click was the one ApplyPilot checked');
});

test('supervised: a click on the form ApplyPilot checked is reported as matching', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  s.scripting.handlers.armSupervised = (_fp, tabId) => {
    setTimeout(() => s.runner.onPageEvent({ type: 'AP_PAGE_EVENT', kind: 'peter_click', matches: true, url: job.applyUrls[0] },
      { id: 'ext', tab: { id: tabId }, url: job.applyUrls[0] }), 5);
    return { armed: true, reason: '' };
  };
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'submitted');
  assert.equal(r.fingerprintMatched, true);
});

test('supervised: Skip gives needs_you and keeps the tab open and watched', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  await s.runner.recover();
  const running = s.runner.run({ countdown: false });
  await until(() => Boolean(s.runner.view().waiting), 'the supervised wait');
  assert.equal(s.job(job.approvalId).state, 'waiting_for_you');
  s.runner.skip(job.approvalId);
  await running;
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.clicked, false);
  assert.equal(r.attemptId, s.bridge.sent[0].attemptId);
  assert.equal(r.reasons[0].text, "You didn't submit this one");
  const tabId = s.job(job.approvalId).tabId;
  assert.ok(s.tabs.open.has(tabId));
  assert.equal(s.storage.data.get(KEYS.watch(tabId)).kind, 'needs_you');
});

test('supervised: no click within the wait gives needs_you', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }] });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'timeout');
  assert.ok(s.slept.includes(30 * 60_000));
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
});

test('page events from tabs the runner does not own, from other hosts, or from another job are ignored', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  await s.runner.recover();
  const running = s.runner.run({ countdown: false });
  await until(() => Boolean(s.runner.view().waiting), 'the supervised wait');
  const tabId = s.job(job.approvalId).tabId;
  const otherJob = `https://jobs.lever.co/acme/${randomUUID()}/apply`;
  assert.equal(s.runner.onPageEvent({ kind: 'peter_click' }, { tab: { id: 999 }, url: job.applyUrls[0] }), false);
  assert.equal(s.runner.onPageEvent({ kind: 'peter_click' }, { tab: { id: tabId }, url: 'https://evil.example/apply' }), false);
  assert.equal(s.runner.onPageEvent({ kind: 'peter_click' }, { tab: { id: tabId }, url: otherJob }), false);
  assert.equal(s.runner.onPageEvent({ kind: 'confirmed' }, { tab: { id: tabId }, url: otherJob.replace(/\/apply$/, '/thanks') }), false);
  assert.equal(s.runner.view().waiting?.approvalId, job.approvalId);
  s.runner.skip(job.approvalId);
  await running;
  // The tab is now a watched needs-you tab: a confirmation for some other job there is still not this one.
  assert.equal(s.runner.onPageEvent({ kind: 'confirmed' }, { tab: { id: tabId }, url: otherJob.replace(/\/apply$/, '/thanks') }), false);
  await tick(20);
  assert.equal((await s.results()).length, 1);
});

// ---- gates ---------------------------------------------------------------------------------------

test('the ledger exception: only a re-approval that supersedes the clicked approval may run', async () => {
  const leverId = randomUUID();
  const jobKey = `lever:acme:${leverId}`;
  const applyUrls = [`https://jobs.lever.co/acme/${leverId}/apply`];
  const clickedApproval = randomUUID();
  const seed = { [KEYS.ledger(jobKey)]: { clickedAt: iso(T0 - HOUR), approvalId: clickedApproval, attemptId: randomUUID(), mode: 'auto' } };
  const s = await setup({ seed, jobs: [makeJob({ jobKey, applyUrls, supersedesId: clickedApproval })] });
  for (const supersedesId of [null, randomUUID()]) {
    const r = await acceptBatch(s.storage, { jobs: [makeJob({ jobKey, applyUrls, supersedesId })] }, { now: T0, sha256 });
    assert.equal(r.accepted.length, 0);
  }
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'submitted');
  assert.equal(s.storage.data.get(KEYS.ledger(jobKey)).approvalId, s.jobs[0].approvalId);
});

test('a ledger entry that appears after the batch was accepted still stops the job before it opens', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.storage.data.set(KEYS.ledger(job.jobKey), { clickedAt: iso(T0), approvalId: randomUUID(), attemptId: randomUUID(), mode: 'auto' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'already_clicked');
  assert.equal(s.tabs.created.length, 0);
  assert.equal(s.bridge.sent.length, 0);
});

test('a refused click after a superseding approval puts the earlier ledger entry back', async () => {
  const leverId = randomUUID();
  const jobKey = `lever:acme:${leverId}`;
  const earlier = { clickedAt: iso(T0 - HOUR), approvalId: randomUUID(), attemptId: randomUUID(), mode: 'auto' };
  const s = await setup({
    seed: { [KEYS.ledger(jobKey)]: earlier },
    jobs: [makeJob({ jobKey, applyUrls: [`https://jobs.lever.co/acme/${leverId}/apply`], supersedesId: earlier.approvalId })],
  });
  s.scripting.handlers.pressSubmit = () => ({ clicked: false, reason: 'submit_changed' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.deepEqual(s.storage.data.get(KEYS.ledger(jobKey)), earlier);
});

test('an open watched tab for the same job blocks the run and the batch', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const tab = await s.tabs.create({ url: job.applyUrls[0] });
  s.storage.data.set(KEYS.watch(tab.id), { approvalId: randomUUID(), jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0) });
  const before = s.tabs.created.length;
  const runner = s.make();
  await runner.recover();
  await runner.run({ countdown: false });
  assert.equal(s.tabs.created.length, before, 'no new tab for a job that is already open');
  assert.equal(s.bridge.sent.length, 0);
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'open_tab');
  const again = await acceptBatch(s.storage, { jobs: [{ ...makeJob(), jobKey: job.jobKey, applyUrls: job.applyUrls }] }, { now: T0, sha256 });
  assert.match(again.rejected[0].reason, /open in a tab/);
});

test('an expired approval is reported cancelled without opening anything', async () => {
  const s = await setup({ jobs: [makeJob({ expiresAt: iso(T0 + HOUR) })] });
  s.advance(2 * HOUR);
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'cancelled');
  assert.equal(r.reasons[0].text, 'Approval expired');
  assert.equal(s.tabs.created.length, 0);
  assert.equal(s.bridge.sent.length, 0);
});

test('missing site access pauses the run before anything opens', async () => {
  const s = await setup({ permitted: false });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'permission');
  assert.equal(s.tabs.created.length, 0);
});

test('a damaged stored PDF is caught before the form opens', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const rec = s.job(job.approvalId);
  s.patchJob(job.approvalId, { job: { ...rec.job, resume: { ...rec.job.resume, b64: Buffer.from('%PDF-1.7 other').toString('base64') } } });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'resume_corrupt');
  assert.equal(s.tabs.created.length, 0);
});

test('a redirect off the ATS host is needs_you and nothing is filled', async () => {
  const s = await setup();
  s.tabs.landOn = () => 'https://careers.acme.example/jobs/1';
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'redirected');
  assert.equal(pageCalls(s, 'fill'), 0);
  assert.equal(s.bridge.sent.length, 0);
});

test('blockers from the audit give needs_you with a banner and no claim', async () => {
  const s = await setup();
  s.scripting.handlers.audit = () => ({
    fingerprint: 'fp-1', relaxations: [], submit: null, report: [],
    blockers: [{ code: 'demographic', text: 'A demographic question needs you: Gender' }, { code: 'no_or_ambiguous_submit', text: 'x' }],
  });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.deepEqual(r.reasons.map((x: Json) => x.code), ['demographic', 'no_or_ambiguous_submit']);
  assert.equal(pageCalls(s, 'bannerNeedsYou'), 1);
  assert.equal(s.bridge.sent.length, 0);
});

test('relaxations go into the claim only while the matching setting is on', async () => {
  const relaxed = () => ({
    fingerprint: 'fp-1', blockers: [], report: [], submit: { path: '#s', label: 'Submit application' },
    relaxations: ['invisible_captcha', 'optional_sensitive_blank', 'privacy_ack'],
  });
  const on = await setup();
  on.scripting.handlers.audit = relaxed;
  await on.runner.recover();
  await on.runner.run({ countdown: false });
  assert.deepEqual(on.bridge.sent[0].relaxations, ['invisible_captcha', 'optional_sensitive_blank', 'privacy_ack']);

  const off = await setup({ settings: { auto: { lever: true }, allowInvisibleCaptcha: false, allowOptionalSensitiveBlank: false, allowPrivacyAck: false } });
  off.scripting.handlers.audit = relaxed;
  await off.runner.recover();
  await off.runner.run({ countdown: false });
  assert.equal(off.bridge.sent.length, 0);
  const [r] = await off.results();
  assert.deepEqual(r.reasons.map((x: Json) => x.code), ['captcha', 'demographic', 'attestation']);
});

test('the fill step is told whether a privacy-policy box may be ticked', async () => {
  for (const allowPrivacyAck of [true, false]) {
    const s = await setup({ settings: { auto: { lever: true }, allowPrivacyAck } });
    let seen: unknown = null;
    const fill = s.scripting.handlers.fill;
    s.scripting.handlers.fill = (args: Json, tabId: number) => {
      seen = args.allowPrivacyAck;
      return fill(args, tabId);
    };
    await s.runner.recover();
    await s.runner.run({ countdown: false });
    assert.equal(seen, allowPrivacyAck);
  }
});

// ---- cancel, watch, results ----------------------------------------------------------------------

test('cancelling while the form is filling stops before the claim', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.fill = () => {
    void cancelJobs(s.storage, [job.approvalId], T0);
    return { filled: [], blockers: [], resumeInputPath: '' };
  };
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  await tick(5);
  assert.equal(s.bridge.sent.length, 0);
  assert.equal(s.job(job.approvalId).state, 'cancelled');
  assert.equal(s.tabs.open.size, 0);
});

test('cancel answers cancelled before the claim and tooLate after it', async () => {
  const s = await setup({ jobs: [makeJob(), makeJob()] });
  const [a, b] = s.jobs;
  s.patchJob(b.approvalId, { state: 'claiming' });
  const r = await cancelJobs(s.storage, [a.approvalId, b.approvalId], T0);
  assert.deepEqual(r, { cancelled: [a.approvalId], tooLate: [b.approvalId] });
  const held = await heldSummary(s.storage, { runnerOpen: true });
  assert.deepEqual(held.held, [b.approvalId]);
});

test('a watched needs-you tab that you submit yourself is recorded as a second result, by you', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'unanswered_required', text: 'Needs your answer: Start date' }], relaxations: [], report: [], submit: null });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  assert.ok(s.storage.data.has(KEYS.watch(tabId)));
  const thanks = job.applyUrls[0].replace(/\/apply$/, '/thanks');
  assert.equal(s.runner.onPageEvent({ kind: 'confirmed', text: 'Thank you for applying.' }, { tab: { id: tabId }, url: thanks }), true);
  await until(async () => (await s.results()).length === 2, 'the second result');
  const [, second] = await s.results();
  assert.equal(second.outcome, 'submitted');
  assert.equal(second.clickedBy, 'you');
  assert.equal(second.clicked, false);
  assert.equal(second.pageUrl, thanks);
  assert.equal(second.fingerprintMatched, false);
  assert.equal(s.storage.data.has(KEYS.watch(tabId)), false);
  // The ledger knows you sent it, so no re-approval is taken, superseding or not, while the result is unsent.
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).mode, 'you');
  for (const supersedesId of [null, job.approvalId]) {
    const again = await acceptBatch(s.storage, { jobs: [makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls, supersedesId })] }, { now: T0, sha256 });
    assert.equal(again.accepted.length, 0, String(supersedesId));
    assert.match(again.rejected[0].reason, /already submitted in Chrome/);
  }
});

test('your own Submit click in a watched needs-you tab locks the job and asks you to check it, with no confirmation seen', async () => {
  const s = await setup({ autoAck: true });
  const [job] = s.jobs;
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'unanswered_required', text: 'Needs your answer: Start date' }], relaxations: [], report: [], submit: null });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  assert.equal(s.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job.applyUrls[0] }), true);
  await until(() => s.delivered.length === 2, 'the check result');
  const check = s.delivered[1];
  assert.deepEqual([check.outcome, check.clickedBy, check.clicked], ['check', 'you', false]);
  assert.equal(check.reasons[0].code, 'you_clicked');
  assert.equal(s.job(job.approvalId).state, 'done:check');
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).mode, 'you');
  assert.equal(s.storage.data.get(KEYS.watch(tabId)).peterClicked, true);
  // A second click once that one reached the server (the form showed an error and you fixed it, or you said it
  // didn't go through and tried again) is news too: it may be the one that sent it.
  s.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job.applyUrls[0] });
  await until(() => s.delivered.length === 3, 'the second check result');
  assert.deepEqual([s.delivered[2].outcome, s.delivered[2].clickedBy, s.delivered[2].reasons[0].code], ['check', 'you', 'you_clicked']);
  assert.equal(s.job(job.approvalId).lastResultId, s.delivered[2].resultId);

  // The site's wording isn't one ApplyPilot knows, so no confirmation comes; you close the tab.
  await s.tabs.remove(tabId);
  s.runner.onTabRemoved(tabId);
  await tick(20);
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [], relaxations: [], submit: { path: '#btn-submit', label: 'Submit application' }, report: [] });
  const again = makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls, applicationId: job.applicationId });
  const r = await acceptBatch(s.storage, { jobs: [again] }, { now: T0, sha256 });
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /already submitted in Chrome/);
  // After you say "It didn't go through", only the approval that replaces that one may run.
  const after = makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls, applicationId: job.applicationId, supersedesId: job.approvalId });
  assert.deepEqual((await acceptBatch(s.storage, { jobs: [after] }, { now: T0, sha256 })).accepted, [after.approvalId]);
});

test('a confirmation after your click in a needs-you tab is recorded as sent by you', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'unanswered_required', text: 'Needs your answer: Start date' }], relaxations: [], report: [], submit: null });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  const thanks = job.applyUrls[0].replace(/\/apply$/, '/thanks');
  s.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job.applyUrls[0] });
  s.runner.onPageEvent({ kind: 'confirmed', text: 'Thank you for applying.' }, { tab: { id: tabId }, url: thanks });
  await until(async () => (await s.results()).length === 3, 'the click and the confirmation');
  assert.deepEqual((await s.results()).map((r: Json) => [r.outcome, r.clickedBy]), [['needs_you', ''], ['check', 'you'], ['submitted', 'you']]);
  assert.equal(s.job(job.approvalId).state, 'done:submitted');
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).outcome, 'submitted');
  assert.equal(s.storage.data.has(KEYS.watch(tabId)), false);
});

test('a check tab ApplyPilot clicked that confirms late is credited to ApplyPilot, unless you pressed Submit there', async () => {
  for (const youClicked of [false, true]) {
    const s = await setup();
    const [job] = s.jobs;
    s.scripting.handlers.readOutcome = () => ({ outcome: 'check', code: 'no_confirmation', reason: 'Submit pressed, no confirmation seen', url: '' });
    await s.runner.recover();
    await s.runner.run({ countdown: false });
    const tabId = s.job(job.approvalId).tabId;
    assert.equal(s.storage.data.get(KEYS.watch(tabId)).clickedBy, 'applypilot');
    if (youClicked) {
      assert.equal(s.runner.onPageEvent({ kind: 'peter_click' }, { tab: { id: tabId }, url: job.applyUrls[0] }), true);
      await until(() => s.storage.data.get(KEYS.watch(tabId))?.clickedBy === 'you', 'the watch to say you clicked');
    }
    const thanks = job.applyUrls[0].replace(/\/apply$/, '/thanks');
    s.runner.onPageEvent({ kind: 'confirmed', text: 'Thank you for applying.' }, { tab: { id: tabId }, url: thanks });
    await until(async () => (await s.results()).length === 2, 'the late confirmation');
    const [, late] = await s.results();
    assert.equal(late.outcome, 'submitted');
    assert.equal(late.clickedBy, youClicked ? 'you' : 'applypilot');
    assert.equal(late.clicked, !youClicked);
    assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).outcome, 'submitted');
  }
});

test('a re-approval of a job Chrome saw submitted is refused, even after "It didn\'t go through" and before the server hears', async () => {
  // ApplyPilot clicked, the result was 'check', then the page confirmed late. Peter said it didn't go through on
  // the dashboard before that result arrived, and approved it again.
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.readOutcome = () => ({ outcome: 'check', code: 'no_confirmation', reason: 'Submit pressed, no confirmation seen', url: '' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  s.runner.onPageEvent({ kind: 'confirmed', text: 'Thank you.' }, { tab: { id: tabId }, url: job.applyUrls[0].replace(/\/apply$/, '/thanks') });
  await until(async () => (await s.results()).length === 2, 'the late confirmation');
  const reapproval = makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls, supersedesId: job.approvalId });
  const r = await acceptBatch(s.storage, { jobs: [reapproval] }, { now: T0, sha256 });
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /already submitted in Chrome/);

  // Only an unsent 'submitted' result says so, the job record already cleaned up: still refused.
  const t = await setup();
  const earlier = randomUUID();
  t.storage.data.set(KEYS.out(randomUUID()), { resultId: randomUUID(), approvalId: earlier, jobKey: 'lever:acme:x', outcome: 'submitted' });
  const leverId = randomUUID();
  const refused = await acceptBatch(t.storage, {
    jobs: [makeJob({ jobKey: `lever:acme:${leverId}`, applyUrls: [`https://jobs.lever.co/acme/${leverId}/apply`], supersedesId: earlier })],
  }, { now: T0, sha256 });
  assert.match(refused.rejected[0]?.reason ?? '', /already submitted in Chrome/);
});

test('the gate before a job opens refuses a re-approval whose superseded approval was submitted', async () => {
  const earlier = randomUUID();
  const s = await setup({ jobs: [makeJob({ supersedesId: earlier })] });
  const [job] = s.jobs;
  // Arrives after the batch was accepted: your own confirmed submission of the earlier approval.
  s.storage.data.set(KEYS.ledger(job.jobKey), { clickedAt: iso(T0), approvalId: earlier, attemptId: null, mode: 'you', outcome: 'submitted' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  assert.equal(r.outcome, 'needs_you');
  assert.equal(r.reasons[0].code, 'already_clicked');
  assert.match(r.reasons[0].text, /already submitted in Chrome/);
  assert.equal(s.tabs.created.length, 0);
  assert.equal(s.bridge.sent.length, 0);
});

test('an unsent result for the same job in another approval holds the claim until the server has it', async () => {
  const s = await setup();
  const [job] = s.jobs;
  // Say, your own submission of an earlier approval of this job, which revokes this one once the server hears.
  s.storage.data.set(KEYS.out('r-earlier'), { resultId: 'r-earlier', approvalId: randomUUID(), jobKey: job.jobKey, outcome: 'needs_you' });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.bridge.sent.length, 0);
  assert.equal(s.storage.data.get(KEYS.run).pausedReason, 'dashboard');
});

test('results stay in storage until the dashboard acknowledges them', async () => {
  const s = await setup();
  const [job] = s.jobs;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const [r] = await s.results();
  await s.make().recover();
  assert.deepEqual((await s.results()).map((x: Json) => x.resultId), [r.resultId], 'a restart keeps unacknowledged results');
  assert.deepEqual(await ackResults(s.storage, [randomUUID()], T0), { acked: [] });
  assert.equal((await s.results()).length, 1);
  assert.deepEqual(await ackResults(s.storage, [r.resultId], T0), { acked: [r.resultId] });
  assert.deepEqual(await s.results(), []);
  assert.equal(s.job(job.approvalId).ackedAt, iso(T0));
  assert.equal(await cleanup(s.storage, T0 + 6 * 24 * HOUR), 0);
  assert.equal(await cleanup(s.storage, T0 + 7 * 24 * HOUR), 1);
  assert.equal(s.job(job.approvalId), undefined);
});

test('re-sending an accepted job is a no-op', async () => {
  const s = await setup();
  const r = await acceptBatch(s.storage, { jobs: [s.jobs[0]] }, { now: T0, sha256 });
  assert.deepEqual(r, { accepted: [s.jobs[0].approvalId], rejected: [] });
});

test('a saved tab id that now shows another page is not the job\'s tab: recovery never closes it, and Chrome starting forgets every saved id', async () => {
  const s = await setup();
  const [job] = s.jobs;
  // After a browser restart Chrome hands the same ids to unrelated tabs.
  const unrelated = await s.tabs.create({ url: 'https://news.example.com/today' });
  const other = await s.tabs.create({ url: `https://jobs.lever.co/acme/${randomUUID()}/apply` });
  s.patchJob(job.approvalId, { state: 'auditing', tabId: unrelated.id });
  s.storage.data.set(KEYS.watch(other.id), { approvalId: randomUUID(), jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0) });
  await forgetTabs(s.storage);
  assert.equal(s.job(job.approvalId).tabId, null);
  assert.equal(s.storage.data.has(KEYS.watch(other.id)), false);
  const runner = s.make();
  await runner.recover();
  assert.equal(s.job(job.approvalId).state, 'queued');
  assert.deepEqual(s.tabs.removed, [], 'nothing of yours is closed');
  assert.equal(runner.onPageEvent({ kind: 'confirmed' }, { tab: { id: other.id }, url: job.applyUrls[0].replace(/\/apply$/, '/thanks') }), false);
  // In the same browser session a half-filled job's tab that you took elsewhere is left open too.
  const t = await setup();
  const [job2] = t.jobs;
  const elsewhere = await t.tabs.create({ url: 'https://news.example.com/today' });
  t.patchJob(job2.approvalId, { state: 'claiming', tabId: elsewhere.id, attemptId: randomUUID() });
  await t.make().recover();
  assert.equal(t.job(job2.approvalId).state, 'queued');
  assert.deepEqual(t.tabs.removed, []);
});

const tabUrlOf = (s: Json) => async (id: number) => {
  try {
    return (await s.tabs.get(id)).url ?? '';
  } catch {
    return null;
  }
};

test('a needs-you tab you took to another page still holds the job: a re-approval waits until that tab closes', async () => {
  const s = await setup({ autoAck: true });
  const [job] = s.jobs;
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'unanswered_required', text: 'Needs your answer: Start date' }], relaxations: [], report: [], submit: null });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  // You open the company's other jobs from the posting, in that same tab.
  s.tabs.open.get(tabId).url = 'https://jobs.lever.co/acme';
  const B = makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls });
  const refused = await acceptBatch(s.storage, { jobs: [B] }, { now: T0, sha256, tabUrl: tabUrlOf(s) } as Json);
  assert.match(refused.rejected[0]?.reason ?? '', /open in a tab/);
  assert.ok(s.storage.data.has(KEYS.watch(tabId)));
  // A re-approval that got in anyway is stopped at the gate before it opens.
  const watch = s.storage.data.get(KEYS.watch(tabId));
  s.storage.data.delete(KEYS.watch(tabId));
  assert.deepEqual((await acceptBatch(s.storage, { jobs: [B] }, { now: T0, sha256 })).accepted, [B.approvalId]);
  s.storage.data.set(KEYS.watch(tabId), watch);
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [], relaxations: [], submit: { path: '#btn-submit', label: 'Submit application' }, report: [] });
  const created = s.tabs.created.length;
  await s.runner.run({ countdown: false });
  assert.equal(s.job(B.approvalId).state, 'done:needs_you');
  assert.equal(s.job(B.approvalId).reasons[0].code, 'open_tab');
  assert.equal(s.tabs.created.length, created);
  assert.equal(pageCalls(s, 'pressSubmit'), 0);
  // Once you close it, the job can be approved again.
  await s.tabs.remove(tabId);
  await tick(10);
  const C = makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls });
  assert.deepEqual((await acceptBatch(s.storage, { jobs: [C] }, { now: T0, sha256, tabUrl: tabUrlOf(s) } as Json)).accepted, [C.approvalId]);
});

test('a supervised wait outlives a runner restart while you have its tab on another page, and your submission there is yours', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: (ms) => ms >= 25 * 60_000 });
  const [job] = s.jobs;
  await s.runner.recover();
  void s.runner.run({ countdown: false });
  await until(() => s.job(job.approvalId)?.state === 'waiting_for_you', 'the supervised wait');
  const tabId = s.job(job.approvalId).tabId;
  s.tabs.open.get(tabId).url = 'https://jobs.lever.co/acme';
  const again = s.make();
  await again.recover();
  assert.equal(s.job(job.approvalId).state, 'waiting_for_you');
  assert.ok(s.storage.data.has(KEYS.watch(tabId)));
  assert.equal((await s.results()).length, 0);
  // You go back to the form in that tab and submit it.
  s.tabs.open.get(tabId).url = job.applyUrls[0];
  const thanks = job.applyUrls[0].replace(/\/apply$/, '/thanks');
  assert.equal(again.onPageEvent({ kind: 'confirmed', text: 'Thank you for applying.' }, { tab: { id: tabId }, url: thanks }), true);
  await until(async () => (await s.results()).length === 1, 'your submission');
  const [r] = await s.results();
  assert.deepEqual([r.outcome, r.clickedBy, r.clicked], ['submitted', 'you', false]);
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).mode, 'you');
});

test('"Show tab" focuses a job\'s saved tab while it shows that job or is still its watched tab, and says why not', async () => {
  const s = await setup();
  const [job] = s.jobs;
  const focused: Json[] = [];
  const chromeLike = {
    tabs: { get: (id: number) => s.tabs.get(id), update: async (id: number) => (focused.push(['tab', id]), s.tabs.update(id)) },
    windows: { update: async (id: number) => void focused.push(['window', id]) },
  };
  const tab = await s.tabs.create({ url: job.applyUrls[0] });
  s.patchJob(job.approvalId, { state: 'done:check', tabId: tab.id });
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, job.approvalId), { ok: true, reason: '' });
  assert.deepEqual(focused, [['tab', tab.id], ['window', 1]]);
  focused.length = 0;
  // The same id on another page (after a restart, an unrelated tab) is not this job's tab, but it is open.
  s.tabs.open.get(tab.id).url = 'https://news.example.com/today';
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, job.approvalId), { ok: false, reason: 'elsewhere' });
  // Another job's watch on that tab id doesn't make it this job's tab.
  s.storage.data.set(KEYS.watch(tab.id), { approvalId: randomUUID(), jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0) });
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, job.approvalId), { ok: false, reason: 'elsewhere' });
  assert.deepEqual(focused, []);
  // Still this job's watched tab, which you took to another page: it is shown, so you can go back to the form there.
  s.storage.data.set(KEYS.watch(tab.id), { approvalId: job.approvalId, jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0) });
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, job.approvalId), { ok: true, reason: '' });
  assert.deepEqual(focused, [['tab', tab.id], ['window', 1]]);
  focused.length = 0;
  await s.tabs.remove(tab.id);
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, job.approvalId), { ok: false, reason: 'gone' });
  assert.deepEqual(await focusJobTab(s.storage, chromeLike, randomUUID()), { ok: false, reason: 'gone' });
  assert.deepEqual(focused, []);
});

test('a watch whose tab closed while the runner was shut is dropped when the next batch arrives', async () => {
  const s = await setup({ jobs: [] });
  const job = makeJob();
  s.storage.data.set(KEYS.watch(555), { approvalId: randomUUID(), jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0) });
  const withTab = (url: string | null): Json => ({ now: T0, sha256, tabUrl: async () => url });
  const kept = await acceptBatch(s.storage, { jobs: [job] }, withTab(job.applyUrls[0]));
  assert.match(kept.rejected[0]?.reason ?? '', /open in a tab/, 'still open on that job: refused');
  for (const url of ['https://jobs.lever.co/acme', '']) {
    const elsewhere = await acceptBatch(s.storage, { jobs: [job] }, withTab(url));
    assert.match(elsewhere.rejected[0]?.reason ?? '', /open in a tab/, `still open, on ${url || 'a page Chrome does not name'}: refused`);
  }
  const r = await acceptBatch(s.storage, { jobs: [job] }, withTab(null));
  assert.deepEqual(r, { accepted: [job.approvalId], rejected: [] });
  assert.equal(s.storage.data.has(KEYS.watch(555)), false);
});

// ---- validateJob ---------------------------------------------------------------------------------

test('validateJob refuses anything that is not exactly the approved job', async () => {
  const ctx = { now: T0, sha256, ledger: () => undefined, watchedKeys: new Set<string>() };
  assert.equal(await validateJob(makeJob(), ctx), '');
  const bad = async (over: Json, pattern: RegExp) => assert.match(await validateJob(makeJob(over), ctx), pattern, JSON.stringify(Object.keys(over)));
  await bad({ approvalId: 'not-a-uuid' }, /isn't valid/);
  await bad({ applyUrls: ['https://jobs.lever.co.evil.com/acme/x/apply'] }, /apply link/);
  await bad({ applyUrls: ['http://jobs.lever.co/acme/5a1b2c3d-1111-2222-3333-444455556666/apply'] }, /apply link/);
  await bad({ applyUrls: ['https://jobs.lever.co/acme/5a1b2c3d-1111-2222-3333-444455556666/apply'] }, /apply link/); // other job
  await bad({ expiresAt: iso(T0 - 1) }, /expired/);
  await bad({ expiresAt: iso(T0 + 25 * HOUR) }, /dates/);
  const job = makeJob();
  await bad({ resume: { ...job.resume, type: 'application/msword' } }, /resume file isn't valid/);
  await bad({ resume: { ...job.resume, size: job.resume.size + 1 } }, /resume file isn't valid/);
  await bad({ resume: { ...job.resume, b64: Buffer.from('not a pdf at all, really').toString('base64'), size: 24 } }, /resume file isn't valid/);
  await bad({ resume: { ...job.resume, sha256: 'b'.repeat(64) } }, /doesn't match/);
  await bad({ profile: { firstName: 'Test', lastName: 'Person' } }, /first name, last name and email/);
});

// ---- your own clicks, wherever ApplyPilot was --------------------------------------------------

const NEEDS_ANSWER = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'unanswered_required', text: 'Needs your answer: Start date' }], relaxations: [], report: [], submit: null });

test('supervised: your Submit click while no wait listens (the runner page reloaded) locks the job and asks you to check it', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  await s.runner.recover();
  void s.runner.run({ countdown: false });
  await until(() => s.job(job.approvalId)?.state === 'waiting_for_you', 'the supervised wait');
  const tabId = s.job(job.approvalId).tabId;
  const attemptId = s.bridge.sent[0].attemptId;
  // The runner page reloads: its wait is gone, and the tab's watch comes back from storage.
  const again = s.make();
  await again.recover();
  assert.equal(s.storage.data.get(KEYS.watch(tabId)).kind, 'supervised');
  const armedBefore = pageCalls(s, 'watchForConfirmation');
  assert.equal(again.onPageEvent({ kind: 'peter_click', matches: true }, { tab: { id: tabId }, url: job.applyUrls[0] }), true);
  await until(async () => (await s.results()).length === 1, 'the check result');
  const [r] = await s.results();
  assert.deepEqual([r.outcome, r.clickedBy, r.clicked, r.attemptId, r.reasons[0].code], ['check', 'you', false, attemptId, 'you_clicked']);
  assert.equal(s.job(job.approvalId).state, 'done:check');
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).mode, 'you');
  assert.equal(s.storage.data.get(KEYS.watch(tabId)).kind, 'check');
  assert.ok(pageCalls(s, 'watchForConfirmation') > armedBefore, 'the tab is watched for a late confirmation');
  // The restarted runner doesn't wait for a click that already happened, and never reports needs_you.
  await again.run({ countdown: false });
  assert.equal((await s.results()).length, 1);
  again.onPageEvent({ kind: 'confirmed', text: 'Thank you for applying.' }, { tab: { id: tabId }, url: job.applyUrls[0].replace(/\/apply$/, '/thanks') });
  await until(async () => (await s.results()).length === 2, 'the confirmation');
  const [, sent] = await s.results();
  assert.deepEqual([sent.outcome, sent.clickedBy, sent.clicked], ['submitted', 'you', false]);
});

test('supervised: a click while the runner page was closed is read back from the page when it opens again', async () => {
  const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: supervisedHang });
  const [job] = s.jobs;
  await s.runner.recover();
  void s.runner.run({ countdown: false });
  await until(() => s.job(job.approvalId)?.state === 'waiting_for_you', 'the supervised wait');
  const attemptId = s.bridge.sent[0].attemptId;
  // No runner page heard the click, but the page remembers it, and that the form matched.
  s.scripting.handlers.clickState = () => ({ clicked: true, at: iso(T0), matches: true });
  s.advance(31 * 60_000);
  const again = s.make();
  await again.recover();
  await again.run({ countdown: false });
  const [r] = await s.results();
  assert.deepEqual([r.outcome, r.clickedBy, r.clicked, r.attemptId, r.fingerprintMatched], ['submitted', 'you', false, attemptId, true]);
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).outcome, 'submitted');
});

test('your own Submit click before ApplyPilot pressed or highlighted anything is locked as yours to check', async () => {
  // While it fills: the page saw the click, and the audit says so.
  const s = await setup({ autoAck: true });
  const [job] = s.jobs;
  s.scripting.handlers.fill = (_a: Json, tabId: number) => {
    s.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job.applyUrls[0] });
    return { filled: [], blockers: [], resumeInputPath: '#resume' };
  };
  s.scripting.handlers.audit = () => ({ fingerprint: 'fp-1', blockers: [{ code: 'you_clicked', text: 'You pressed Submit on this page yourself.' }], relaxations: [], report: [], submit: null });
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.bridge.sent.length, 0, 'nothing is claimed');
  assert.equal(s.delivered.length, 1);
  const [r] = s.delivered;
  assert.deepEqual([r.outcome, r.clickedBy, r.clicked, r.attemptId, r.reasons[0].code], ['check', 'you', false, null, 'you_clicked']);
  assert.equal(s.storage.data.get(KEYS.ledger(job.jobKey)).mode, 'you');
  assert.equal(s.storage.data.get(KEYS.watch(s.job(job.approvalId).tabId)).kind, 'check');
  assert.equal((await acceptBatch(s.storage, { jobs: [makeJob({ jobKey: job.jobKey, applyUrls: job.applyUrls })] }, { now: T0, sha256 })).accepted.length, 0);

  // After the claim: ApplyPilot's own press is refused, since the page saw your click first.
  const t = await setup();
  const [job2] = t.jobs;
  t.scripting.handlers.pressSubmit = () => ({ clicked: false, reason: 'already_clicked', text: 'ApplyPilot already pressed Submit on this page.' });
  t.scripting.handlers.clickState = () => ({ clicked: true, at: iso(T0), matches: false });
  await t.runner.recover();
  await t.runner.run({ countdown: false });
  const [r2] = await t.results();
  assert.deepEqual([r2.outcome, r2.clickedBy, r2.clicked, r2.attemptId], ['check', 'you', false, t.bridge.sent[0].attemptId]);
  assert.equal(t.storage.data.get(KEYS.ledger(job2.jobKey)).mode, 'you');

  // While ApplyPilot puts up its needs-you banner: the click goes to the tab's watch once the job is done.
  const u = await setup({ autoAck: true });
  const [job3] = u.jobs;
  u.scripting.handlers.audit = NEEDS_ANSWER;
  u.scripting.handlers.bannerNeedsYou = (reasons: Json, tabId: number) => {
    u.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job3.applyUrls[0] });
    return { shown: true, count: reasons.length };
  };
  await u.runner.recover();
  await u.runner.run({ countdown: false });
  await until(() => u.delivered.length === 2, 'your click after the needs-you result');
  assert.deepEqual(u.delivered.map((x: Json) => [x.outcome, x.clickedBy]), [['needs_you', ''], ['check', 'you']]);
});

test('a second Submit click while the first one\'s "check" is still on its way adds no second result', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.scripting.handlers.audit = NEEDS_ANSWER;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  const tabId = s.job(job.approvalId).tabId;
  for (let i = 0; i < 2; i++) s.runner.onPageEvent({ kind: 'peter_click', matches: false }, { tab: { id: tabId }, url: job.applyUrls[0] });
  await until(async () => (await s.results()).length === 2, 'the check result');
  await tick(20);
  assert.deepEqual((await s.results()).map((r: Json) => r.outcome), ['needs_you', 'check']);
});

test('supervised: Skip, Stop or the wait running out takes back the green "everything matches" in the tab', async () => {
  for (const how of ['skip', 'stop', 'timeout']) {
    const s = await setup({ claims: [{ ok: true, mode: 'supervised' }], hang: how === 'timeout' ? () => false : supervisedHang });
    const [job] = s.jobs;
    s.scripting.handlers.disarm = (reasons: Json) => ({ disarmed: true, count: reasons.length });
    await s.runner.recover();
    const running = s.runner.run({ countdown: false });
    if (how !== 'timeout') {
      await until(() => Boolean(s.runner.view().waiting), 'the supervised wait');
      if (how === 'skip') s.runner.skip(job.approvalId);
      else await s.runner.stop();
    }
    await running;
    assert.equal(pageCalls(s, 'disarm'), 1, how);
    assert.equal(pageCalls(s, 'bannerNeedsYou'), 0, how);
    assert.equal((await s.results())[0].outcome, 'needs_you', how);
  }
});

test('the next form opens in the window the runner page is in now, or wherever Chrome puts it once that window is gone', async () => {
  // You moved the runner page to another window.
  const s = await setup({ deps: { currentWindowId: async () => 7 } });
  const asked: Json[] = [];
  const create = s.tabs.create;
  s.tabs.create = async (p: Json) => (asked.push(p.windowId), create(p));
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.deepEqual(asked, [7]);
  assert.equal((await s.results())[0].outcome, 'submitted');
  // The window it started in was closed, and nothing says where the page is now.
  const t = await setup();
  const tried: Json[] = [];
  const make = t.tabs.create;
  t.tabs.create = async (p: Json) => {
    tried.push(p.windowId);
    if (p.windowId === 1) throw new Error('No window with id: 1.');
    return make(p);
  };
  await t.runner.recover();
  await t.runner.run({ countdown: false });
  assert.deepEqual(tried, [1, undefined]);
  assert.equal((await t.results())[0].outcome, 'submitted');
});

test('a ninth watched tab drops the oldest one you are not looking at, and closes it only while it still shows that job', async () => {
  const s = await setup({ autoAck: true });
  const seeded: number[] = [];
  for (let i = 0; i < 8; i++) {
    const id = randomUUID();
    const tab = await s.tabs.create({ url: `https://jobs.lever.co/acme/${id}/apply` });
    seeded.push(tab.id);
    s.storage.data.set(KEYS.watch(tab.id), { approvalId: randomUUID(), jobKey: `lever:acme:${id}`, ats: 'lever', kind: 'needs_you', since: iso(T0 - (10 - i) * HOUR) });
  }
  // The oldest is the tab you are looking at; the next oldest you took to another page.
  s.tabs.open.get(seeded[0]).active = true;
  s.tabs.open.get(seeded[1]).url = 'https://news.example.com/today';
  s.scripting.handlers.audit = NEEDS_ANSWER;
  await s.runner.recover();
  await s.runner.run({ countdown: false });
  assert.equal(s.job(s.jobs[0].approvalId).state, 'done:needs_you');
  assert.ok(s.storage.data.has(KEYS.watch(seeded[0])), 'the tab you are looking at keeps its watch');
  assert.equal(s.storage.data.has(KEYS.watch(seeded[1])), false, 'the next oldest is dropped');
  assert.deepEqual(s.tabs.removed, [], 'and its tab, on another page now, stays open');
  // The next one dropped still shows its job, so its tab closes.
  const next = makeJob();
  assert.deepEqual((await acceptBatch(s.storage, { jobs: [next] }, { now: T0, sha256 })).accepted, [next.approvalId]);
  await s.runner.run({ countdown: false });
  assert.equal(s.storage.data.has(KEYS.watch(seeded[2])), false);
  assert.deepEqual(s.tabs.removed, [seeded[2]]);
  assert.ok(s.storage.data.has(KEYS.watch(seeded[0])));
});

test('Chrome starting forgets old tab ids without undoing what a runner page saved meanwhile', async () => {
  const s = await setup();
  const [job] = s.jobs;
  s.patchJob(job.approvalId, { state: 'auditing', tabId: 5 });
  s.storage.data.set(KEYS.watch(5), { approvalId: randomUUID(), jobKey: 'lever:acme:old', ats: 'lever', kind: 'needs_you', since: iso(T0 - HOUR) });
  const fresh = { approvalId: job.approvalId, jobKey: job.jobKey, ats: 'lever', kind: 'needs_you', since: iso(T0 + 1000) };
  const racing = {
    ...s.storage,
    get: async (keys: Json) => {
      const out = await s.storage.get(keys);
      if (keys == null) {
        // A runner page recovers and opens the job again between forgetTabs' read and its writes.
        s.patchJob(job.approvalId, { state: 'filling', tabId: 101 });
        s.storage.data.set(KEYS.watch(5), fresh);
      }
      return out;
    },
  };
  await forgetTabs(racing);
  assert.deepEqual([s.job(job.approvalId).state, s.job(job.approvalId).tabId], ['filling', 101]);
  assert.deepEqual(s.storage.data.get(KEYS.watch(5)), fresh);
});

test('the form is filled knowing the job\'s company and whether its posting is in the U.S.', async () => {
  for (const [over, want] of [[{ usPosting: true }, true], [{}, false]] as const) {
    const s = await setup({ jobs: [makeJob(over)] });
    const seen: Json[] = [];
    const fill = s.scripting.handlers.fill;
    s.scripting.handlers.fill = (arg: Json, tabId: number) => (seen.push(arg), fill(arg, tabId));
    await s.runner.recover();
    await s.runner.run({ countdown: false });
    assert.deepEqual([seen[0].company, seen[0].usPosting], ['Acme Health', want]);
  }
  const ctx = { now: T0, sha256, ledger: () => undefined, watchedKeys: new Set<string>() };
  assert.match(await validateJob(makeJob({ usPosting: 'yes' }), ctx), /isn't valid/);
});
