// The batch runner's state machine and the storage records it shares with background.js.
// No chrome globals: every API comes in through deps, so tests/runner-core.test.ts can run it in node with fakes.

import { HOST_PATTERNS, isAllowedUrl, isAts, parseAtsUrl } from "./ats.js";

export const DASHBOARD_ORIGIN = "https://applypilot-hub.amused-bream-5718.chatgpt.site";
export const DASHBOARD_URL = `${DASHBOARD_ORIGIN}/`;
export const EXTENSION_VERSION = "3.2.0";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
export const LIMITS = {
  batchJobs: 20,
  pdfBytes: 2 * 1024 * 1024,
  approvalWindowMs: DAY + 5 * MINUTE,
  watches: 8,
  keepAckedMs: 7 * DAY,
  reasons: 10,
  report: 60,
};
const TIMES = {
  load: 45 * SECOND,
  form: 20 * SECOND,
  // The page gets fillBudget; the rest is margin for the call itself. Filling settles and checks again after a page
  // that re-renders, so a slow form can use most of it.
  fill: 180 * SECOND,
  fillBudget: 150 * SECOND,
  audit: 30 * SECOND,
  quick: 10 * SECOND,
  supervised: 30 * MINUTE,
  outcome: 45 * SECOND,
  autoSpacing: MINUTE,
  closeAfter: 5 * SECOND,
  releasePoll: 500,
  releaseTries: 30,
  navigationStart: 500,
};

export const KEYS = {
  job: (id) => `apJob:${id}`,
  ledger: (jobKey) => `apLedger:${jobKey}`,
  out: (resultId) => `apOut:${resultId}`,
  watch: (tabId) => `apWatch:${tabId}`,
  cancel: (id) => `apCancel:${id}`,
  halt: "apHalt",
  run: "apRun",
};

const PENDING = new Set(["queued", "paused"]);
const PRE_CLAIM = new Set(["queued", "paused", "opening", "filling", "auditing"]);
export const isTerminal = (state) => state === "cancelled" || String(state).startsWith("done:");

export const STATE_LABELS = {
  queued: "Waiting",
  paused: "Paused",
  opening: "Opening the form",
  filling: "Filling",
  auditing: "Checking the form",
  claiming: "Confirming with ApplyPilot",
  submitting: "Submitting",
  waiting_for_you: "Waiting for you to click Submit",
  observing: "Watching for the confirmation",
  cancelled: "Cancelled",
  "done:submitted": "Sent",
  "done:needs_you": "Needs you",
  "done:check": "Check this one",
  "done:cancelled": "Cancelled",
};

export const PAUSE_TEXT = {
  halted: "Stopped. Press Resume to continue.",
  countdown: "Paused. Press Resume to start.",
  permission: "ApplyPilot needs access to Greenhouse, Lever and Ashby to open the forms.",
  dashboard: "Open ApplyPilot in a tab to continue. Sending resumes once it's open.",
  daily_cap: "You reached your daily limit for automatic submissions.",
  spacing: "Waiting a minute between automatic submissions.",
};

// Server claim denials, as one plain sentence each.
const DENIAL = {
  revoked: "You cancelled this approval.",
  expired: "Approval expired",
  resume_changed: "The resume changed after you approved. Approve again.",
  profile_changed: "Your profile changed after you approved. Approve again.",
  setting_changed: "Your submit settings changed after you approved. Approve again.",
  already_submitted: "This job was already submitted.",
  already_claimed: "ApplyPilot is already sending this one.",
  status_final: "This job is already marked as done in ApplyPilot.",
  not_found: "ApplyPilot couldn't find this approval.",
  wrong_page: "The page didn't match the job you approved.",
  invalid_request: "ApplyPilot couldn't confirm this approval.",
  attempt_closed: "ApplyPilot already gave this try back. Approve it again if it still needs sending.",
};
const TRANSPORT = new Set(["network", "timeout", "no_dashboard"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const RELAXATIONS = new Set(["invisible_captcha", "optional_sensitive_blank", "privacy_ack"]);
const TIMED_OUT = Object.freeze({ __apTimeout: true });

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const clip = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const R = (code, text) => ({ code: clip(code, 60), text: clip(text, 200) });
const valuesWith = (all, prefix) =>
  Object.entries(all || {}).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).filter(isObject);

export function base64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function cleanReasons(list) {
  return (Array.isArray(list) ? list : [])
    .filter(isObject)
    .map((r) => R(r.code, r.text))
    .filter((r) => r.code || r.text)
    .slice(0, LIMITS.reasons);
}

function cleanReport(list) {
  return (Array.isArray(list) ? list : []).filter(isObject).slice(0, LIMITS.report).map((e) => ({
    label: clip(e.label, 200),
    type: clip(e.type, 40),
    required: e.required === true,
    value: clip(e.value, 500),
    source: clip(e.source, 40),
  }));
}

export function cleanSettings(s) {
  const o = isObject(s) ? s : {};
  const auto = isObject(o.auto) ? o.auto : {};
  return {
    // Informational: the server decides at claim time. Defaults match the server's (Peter chose "Skip both").
    allowInvisibleCaptcha: o.allowInvisibleCaptcha !== false,
    allowOptionalSensitiveBlank: o.allowOptionalSensitiveBlank !== false,
    // Only a dashboard that offers the privacy-box setting sends it; an older one never asked, so the box stays yours.
    allowPrivacyAck: o.allowPrivacyAck === true,
    dailyCap: Number.isSafeInteger(o.dailyCap) ? o.dailyCap : 10,
    auto: { greenhouse: auto.greenhouse === true, lever: auto.lever === true, ashby: auto.ashby === true },
  };
}

function cleanJob(job) {
  const p = isObject(job.profile) ? job.profile : {};
  return {
    approvalId: job.approvalId,
    applicationId: job.applicationId,
    jobKey: job.jobKey,
    ats: job.ats,
    applyUrls: [...job.applyUrls],
    company: job.company,
    role: job.role,
    revision: job.revision,
    approvedAt: job.approvedAt,
    expiresAt: job.expiresAt,
    supersedesId: job.supersedesId ?? null,
    profile: JSON.parse(JSON.stringify(p)),
    profileHash: job.profileHash,
    resume: {
      name: job.resume.name,
      type: job.resume.type,
      size: job.resume.size,
      sha256: job.resume.sha256,
      b64: job.resume.b64,
    },
    coverLetter: job.coverLetter,
    // Whether the posting is in the U.S., where your work-authorization answers apply.
    usPosting: job.usPosting === true,
  };
}

const withoutPdf = (job) => ({ ...job, resume: { ...job.resume, b64: undefined } });

// ---- batch intake (background.js) --------------------------------------------------------------

const REJECT = {
  invalid: "This approval isn't valid. Approve it again.",
  url: "The apply link isn't the Greenhouse, Lever or Ashby form for this job.",
  dates: "The approval dates aren't valid. Approve it again.",
  expired: "Approval expired",
  pdf: "The resume file isn't valid. Approve it again.",
  pdfHash: "The resume file doesn't match the one you approved.",
  profile: "Your profile needs a first name, last name and email.",
  ledger: "ApplyPilot already pressed Submit for this job once. Check it before sending it again.",
  sent: "This job was already submitted in Chrome. Check it before sending it again.",
  watch: "This job is open in a tab that needs you. Finish or close that tab first.",
  duplicate: "ApplyPilot is already sending this job.",
};

// Approvals Chrome saw submitted, whether or not the server has heard yet.
export function sentApprovals(all) {
  return new Set(
    [
      ...valuesWith(all, "apJob:").filter((r) => r.state === "done:submitted").map((r) => r.job?.approvalId),
      ...valuesWith(all, "apOut:").filter((r) => r.outcome === "submitted").map((r) => r.approvalId),
    ].filter(Boolean),
  );
}

// The only way past a click: Peter said "It didn't go through" and approved the job again. Never past a
// submission Chrome saw confirmed, even when the server hasn't heard of it yet.
function ledgerRefusal(entry, job, sent) {
  if (job.supersedesId && sent.has(job.supersedesId)) return REJECT.sent;
  if (!isObject(entry)) return "";
  if (job.supersedesId && entry.approvalId === job.supersedesId && entry.outcome !== "submitted") return "";
  return entry.mode === "you" ? REJECT.sent : REJECT.ledger;
}

// Returns "" when the job may be queued, otherwise one plain sentence.
export async function validateJob(job, { now, sha256, ledger, watchedKeys, sent = new Set() }) {
  if (!isObject(job) || !UUID.test(String(job.approvalId))) return REJECT.invalid;
  if (!str(job.applicationId, 80) || !str(job.jobKey, 200) || !isAts(job.ats)) return REJECT.invalid;
  if (typeof job.company !== "string" || typeof job.role !== "string" || job.company.length > 300 || job.role.length > 300)
    return REJECT.invalid;
  if (!Number.isSafeInteger(job.revision) || !HEX64.test(String(job.profileHash))) return REJECT.invalid;
  if (job.supersedesId != null && !UUID.test(String(job.supersedesId))) return REJECT.invalid;
  if (typeof job.coverLetter !== "string" || job.coverLetter.length > 4000) return REJECT.invalid;
  if (job.usPosting !== undefined && typeof job.usPosting !== "boolean") return REJECT.invalid;

  if (!Array.isArray(job.applyUrls) || job.applyUrls.length < 1 || job.applyUrls.length > 4) return REJECT.url;
  for (const url of job.applyUrls) {
    if (typeof url !== "string" || !isAllowedUrl(url)) return REJECT.url;
    const p = parseAtsUrl(url);
    if (!p || p.jobKey !== job.jobKey || p.ats !== job.ats) return REJECT.url;
  }

  const approved = Date.parse(job.approvedAt);
  const expires = Date.parse(job.expiresAt);
  if (typeof job.approvedAt !== "string" || typeof job.expiresAt !== "string" || !Number.isFinite(approved) || !Number.isFinite(expires))
    return REJECT.dates;
  if (expires <= now) return REJECT.expired;
  if (expires > approved + LIMITS.approvalWindowMs) return REJECT.dates;

  const r = job.resume;
  if (!isObject(r) || r.type !== "application/pdf" || !Number.isSafeInteger(r.size) || r.size < 5 || r.size > LIMITS.pdfBytes)
    return REJECT.pdf;
  if (!str(r.name, 200) || /[/\\]/.test(r.name) || !HEX64.test(String(r.sha256)) || typeof r.b64 !== "string") return REJECT.pdf;
  let bytes;
  try {
    bytes = base64Bytes(r.b64);
  } catch {
    return REJECT.pdf;
  }
  if (bytes.length !== r.size || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return REJECT.pdf;
  if ((await sha256(bytes)) !== r.sha256) return REJECT.pdfHash;

  const p = job.profile;
  if (!isObject(p) || !str(p.firstName, 200) || !str(p.lastName, 200) || !str(p.email, 320)) return REJECT.profile;

  const refusal = ledgerRefusal(ledger(job.jobKey), job, sent);
  if (refusal) return refusal;
  if (watchedKeys.has(job.jobKey)) return REJECT.watch;
  return "";
}

// tabUrl(tabId) gives a tab's URL, or null when the tab is gone. A watch whose tab closed while the runner
// wasn't open is dropped here, so it can't refuse a job forever. A tab still open on any page keeps its watch:
// you may go back to the form there and submit it.
export async function acceptBatch(storage, batch, { now, sha256, tabUrl = null }) {
  const accepted = [];
  const rejected = [];
  if (!isObject(batch) || !Array.isArray(batch.jobs) || batch.jobs.length < 1 || batch.jobs.length > LIMITS.batchJobs) {
    return { accepted, rejected: [{ approvalId: "", reason: REJECT.invalid }] };
  }
  const all = await storage.get(null);
  const stale = [];
  const watchedKeys = new Set();
  for (const [key, w] of Object.entries(all || {})) {
    if (!key.startsWith("apWatch:") || !isObject(w)) continue;
    if (tabUrl && typeof (await tabUrl(Number(key.slice("apWatch:".length)))) !== "string") {
      stale.push(key);
      continue;
    }
    watchedKeys.add(w.jobKey);
  }
  if (stale.length) await storage.remove(stale);
  const sent = sentApprovals(all);
  const live = new Map();
  for (const rec of valuesWith(all, "apJob:")) {
    const id = rec.job?.approvalId;
    if (id && !isTerminal(rec.state) && !all[KEYS.cancel(id)]) live.set(rec.job.jobKey, id);
  }
  const settings = cleanSettings(batch.settings);
  const at = new Date(now).toISOString();
  const writes = {};
  for (const job of batch.jobs) {
    const id = isObject(job) && typeof job.approvalId === "string" ? job.approvalId : "";
    if (UUID.test(id) && (all[KEYS.job(id)] || writes[KEYS.job(id)])) {
      accepted.push(id);
      continue;
    }
    let reason = await validateJob(job, { now, sha256, ledger: (k) => all[KEYS.ledger(k)], watchedKeys, sent });
    if (!reason && live.has(job.jobKey)) reason = REJECT.duplicate;
    if (reason) {
      rejected.push({ approvalId: id, reason });
      continue;
    }
    live.set(job.jobKey, id);
    writes[KEYS.job(id)] = {
      job: cleanJob(job),
      settings,
      batchId: clip(batch.batchId, 60),
      state: "queued",
      reasons: [],
      tabId: null,
      attemptId: null,
      claim: null,
      acceptedAt: at,
      updatedAt: at,
    };
    accepted.push(id);
  }
  if (Object.keys(writes).length) await storage.set(writes);
  return { accepted, rejected };
}

export async function cancelJobs(storage, approvalIds, now) {
  const ids = (Array.isArray(approvalIds) ? approvalIds : []).filter((x) => typeof x === "string" && UUID.test(x)).slice(0, 200);
  const all = await storage.get(null);
  const cancelled = [];
  const tooLate = [];
  const marks = {};
  for (const id of ids) {
    const rec = all[KEYS.job(id)];
    if (!rec || rec.state === "cancelled" || rec.state === "done:cancelled") cancelled.push(id);
    else if (PRE_CLAIM.has(rec.state)) {
      // A marker, not an edit of the job record, so this never races the runner's own writes.
      marks[KEYS.cancel(id)] = { at: new Date(now).toISOString() };
      cancelled.push(id);
    } else tooLate.push(id);
  }
  if (Object.keys(marks).length) await storage.set(marks);
  return { cancelled, tooLate };
}

export async function heldSummary(storage, { runnerOpen }) {
  const all = await storage.get(null);
  const held = valuesWith(all, "apJob:")
    .filter((rec) => rec.job?.approvalId && rec.state !== "cancelled" && !all[KEYS.cancel(rec.job.approvalId)])
    .map((rec) => rec.job.approvalId);
  return {
    held,
    running: Boolean(runnerOpen) && all[KEYS.run]?.state === "running",
    resultsWaiting: valuesWith(all, "apOut:").length,
  };
}

export async function pullResults(storage) {
  const all = await storage.get(null);
  return valuesWith(all, "apOut:").sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
}

// Results stay in storage until the dashboard says the server saved them.
export async function ackResults(storage, resultIds, now) {
  const ids = (Array.isArray(resultIds) ? resultIds : []).filter((x) => typeof x === "string" && x.length <= 60);
  const all = await storage.get(null);
  const acked = ids.filter((id) => isObject(all[KEYS.out(id)]));
  if (acked.length) await storage.remove(acked.map(KEYS.out));
  const at = new Date(now).toISOString();
  for (const approvalId of new Set(acked.map((id) => all[KEYS.out(id)].approvalId))) {
    const key = KEYS.job(approvalId);
    const rec = (await storage.get(key))[key];
    if (isObject(rec) && isTerminal(rec.state)) await storage.set({ [key]: { ...rec, ackedAt: at } });
  }
  await cleanup(storage, now);
  return { acked };
}

// Chrome gives tab ids out again after it restarts, so background.js forgets every saved one when Chrome
// starts. Within one browser session an id is that tab's for as long as it is open.
export async function forgetTabs(storage) {
  const all = (await storage.get(null)) || {};
  // Each record is read again before it is changed: a runner page that started meanwhile may have saved it since,
  // and an old copy written back would undo that.
  for (const [key, w] of Object.entries(all)) {
    if (!key.startsWith("apWatch:") || !isObject(w)) continue;
    const latest = (await storage.get(key))?.[key];
    if (isObject(latest) && latest.since === w.since && latest.approvalId === w.approvalId) await storage.remove(key);
  }
  for (const [key, rec] of Object.entries(all)) {
    if (!key.startsWith("apJob:") || !isObject(rec) || rec.tabId == null) continue;
    const latest = (await storage.get(key))?.[key];
    if (isObject(latest) && latest.tabId === rec.tabId) await storage.set({ [key]: { ...latest, tabId: null } });
  }
}

// "Show tab" on the dashboard: a job's saved tab is brought forward while it shows that job, or while it is still
// that job's watched tab on another page (you can go back to the form there). reason says why not: "gone" or
// "elsewhere".
export async function focusJobTab(storage, { tabs, windows }, approvalId) {
  const gone = { ok: false, reason: "gone" };
  if (typeof approvalId !== "string") return gone;
  const key = KEYS.job(approvalId);
  const rec = (await storage.get(key))[key];
  if (!isObject(rec) || typeof rec.tabId !== "number" || typeof rec.job?.jobKey !== "string") return gone;
  try {
    const tab = await tabs.get(rec.tabId);
    if (!tab) return gone;
    const shows = typeof tab.url === "string" && isAllowedUrl(tab.url) && parseAtsUrl(tab.url)?.jobKey === rec.job.jobKey;
    if (!shows) {
      const w = (await storage.get(KEYS.watch(rec.tabId)))?.[KEYS.watch(rec.tabId)];
      if (!isObject(w) || w.approvalId !== approvalId) return { ok: false, reason: "elsewhere" };
    }
    await tabs.update(rec.tabId, { active: true });
    if (typeof tab.windowId === "number") await windows.update(tab.windowId, { focused: true });
    return { ok: true, reason: "" };
  } catch {
    return gone;
  }
}

export async function cleanup(storage, now) {
  const all = await storage.get(null);
  const waiting = new Set(valuesWith(all, "apOut:").map((r) => r.approvalId));
  const watched = new Set(valuesWith(all, "apWatch:").map((w) => w.approvalId));
  const drop = [];
  for (const rec of valuesWith(all, "apJob:")) {
    const id = rec.job?.approvalId;
    const acked = Date.parse(rec.ackedAt);
    if (!id || !isTerminal(rec.state) || waiting.has(id) || watched.has(id) || !Number.isFinite(acked)) continue;
    if (now - acked >= LIMITS.keepAckedMs) drop.push(KEYS.job(id), KEYS.cancel(id));
  }
  if (drop.length) await storage.remove(drop);
  return drop.length / 2;
}

// ---- the runner ---------------------------------------------------------------------------------

// Runs inside the job tab's isolated world. Self-contained, because chrome serializes it.
const PAGE_CALL = (method, args) => {
  const ap = globalThis.__applypilot;
  if (!ap || typeof ap[method] !== "function") return { __apMissing: true };
  try {
    const r = ap[method](...args);
    return r && typeof r.then === "function" ? r.then((v) => v, (e) => ({ __apError: String((e && e.message) || e) })) : r;
  } catch (e) {
    return { __apError: String((e && e.message) || e) };
  }
};

class Abort extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

export function createRunner(deps, opts = {}) {
  const { storage, tabs, scripting, permissions, bridge, sha256, now, sleep, uuid } = deps;
  const windows = deps.windows || null;
  const version = opts.version || EXTENSION_VERSION;
  const countdownMs = opts.countdownMs ?? 10 * SECOND;

  let runState = { state: "idle", windowId: opts.windowId ?? null, current: null, lastAutoClaimAt: 0, pausedReason: "", pausedText: "", resumeAt: null };
  let halted = false;
  let running = false;
  let wakeLater = false;
  let countdownPaused = false;
  let countdown = 0;
  let current = null; // { id, jobKey, tabId }
  let restored = null; // apRun as the last runner left it
  let waiting = null;
  const waiters = new Set();
  const early = new Map(); // tabId -> page event that arrived before anyone waited for it
  const watches = new Map(); // tabId -> watch record
  const jobs = new Map(); // approvalId -> summary for the UI
  const listeners = new Set();

  const iso = () => new Date(now()).toISOString();
  const get1 = async (key) => (await storage.get(key))?.[key];
  const emit = () => {
    const v = view();
    for (const fn of listeners) {
      try {
        fn(v);
      } catch {}
    }
  };
  const quiet = (p) => Promise.resolve(p).catch(() => {});

  function view() {
    return {
      run: { ...runState },
      halted,
      countdown,
      waiting: waiting ? { ...waiting } : null,
      jobs: [...jobs.values()].sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt))),
    };
  }

  function track(rec) {
    const j = rec.job;
    jobs.set(j.approvalId, {
      approvalId: j.approvalId,
      role: j.role,
      company: j.company,
      ats: j.ats,
      approvedAt: j.approvedAt,
      state: rec.state,
      label: STATE_LABELS[rec.state] || rec.state,
      reasons: cleanReasons(rec.reasons),
      tabId: rec.tabId ?? null,
    });
  }

  async function writeRun(patch) {
    runState = { ...runState, ...patch };
    await storage.set({ [KEYS.run]: runState });
    emit();
  }

  async function saveJob(rec, patch = {}) {
    Object.assign(rec, patch, { updatedAt: iso() });
    await storage.set({ [KEYS.job(rec.job.approvalId)]: rec });
    track(rec);
    emit();
    quiet(bridge.notify("AP_PROGRESS", { approvalId: rec.job.approvalId, state: rec.state, note: STATE_LABELS[rec.state] || "" }));
  }

  async function isHalted() {
    halted = (await get1(KEYS.halt)) === true;
    return halted;
  }
  const isCancelled = async (id) => Boolean(await get1(KEYS.cancel(id)));

  function within(promise, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const once = (fn) => (v) => {
        if (done) return;
        done = true;
        fn(v);
      };
      promise.then(once(resolve), once(reject));
      sleep(ms).then(() => once(resolve)(TIMED_OUT));
    });
  }

  function page(tabId, method, arg, ms) {
    const call = new Promise((resolve) =>
      resolve(scripting.executeScript({ target: { tabId }, func: PAGE_CALL, args: [method, arg === undefined ? [] : [arg]] })),
    ).then((out) => (Array.isArray(out) && out[0] ? out[0].result ?? null : null));
    return within(call, ms);
  }
  const usable = (r) => isObject(r) && !r.__apMissing && !r.__apError && !r.__apTimeout;

  async function inject(tabId) {
    try {
      await scripting.executeScript({ target: { tabId }, files: ["page-lib.js"] });
      return true;
    } catch {
      return false;
    }
  }

  async function tabInfo(tabId) {
    if (typeof tabId !== "number") return null;
    try {
      return (await tabs.get(tabId)) || null;
    } catch {
      return null;
    }
  }
  const closeTab = (tabId) => (typeof tabId === "number" ? quiet(tabs.remove(tabId)) : Promise.resolve());
  // ApplyPilot closes a saved tab only while it shows that job, never one you took to another page.
  async function showsJob(tabId, jobKey) {
    const t = await tabInfo(tabId);
    return Boolean(t && typeof t.url === "string" && isAllowedUrl(t.url) && parseAtsUrl(t.url)?.jobKey === jobKey);
  }

  async function focusTab(tabId) {
    const t = await tabInfo(tabId);
    if (!t) return;
    await quiet(tabs.update(tabId, { active: true }));
    if (windows && typeof t.windowId === "number") await quiet(windows.update(t.windowId, { focused: true }));
  }

  function waitForComplete(tabId, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        tabs.onUpdated.removeListener(onUpdated);
        tabs.onRemoved.removeListener(onRemoved);
        resolve(v);
      };
      const onUpdated = (id, info, tab) => {
        if (id === tabId && info && info.status === "complete") finish({ ok: true, tab });
      };
      const onRemoved = (id) => {
        if (id === tabId) finish({ ok: false, reason: "closed" });
      };
      tabs.onUpdated.addListener(onUpdated);
      tabs.onRemoved.addListener(onRemoved);
      sleep(ms).then(() => finish({ ok: false, reason: "timeout" }));
      Promise.resolve(tabs.get(tabId)).then(
        (t) => {
          if (t && t.status === "complete" && !t.pendingUrl) finish({ ok: true, tab: t });
        },
        () => finish({ ok: false, reason: "closed" }),
      );
    });
  }

  // One wait that a page event, Skip, Stop, a closed tab or the timer can end.
  function waitEvent({ tabId = null, kinds = [], ms, approvalId = null }) {
    return new Promise((resolve) => {
      let done = false;
      const w = {
        tabId,
        kinds,
        approvalId,
        resolve: (ev) => {
          if (done) return;
          done = true;
          waiters.delete(w);
          resolve(ev);
        },
      };
      waiters.add(w);
      const e = tabId != null ? early.get(tabId) : null;
      if (e && kinds.includes(e.kind)) {
        early.delete(tabId);
        return w.resolve({ type: e.kind, ...e });
      }
      if (halted) return w.resolve({ type: "halt" });
      sleep(ms).then(() => w.resolve({ type: "timeout" }));
    });
  }

  // ---- watches ----

  // clickedBy is who pressed Submit in that tab so far; a later confirmation there is credited to them.
  async function addWatch(tabId, rec, kind, attemptId, clickedBy = "you") {
    const t = await tabInfo(tabId);
    // A page ApplyPilot can't read (the company's own site) can't be watched.
    if (!t || !t.url || !isAllowedUrl(t.url)) return removeWatch(tabId);
    const j = rec.job;
    const w = {
      approvalId: j.approvalId,
      applicationId: j.applicationId,
      jobKey: j.jobKey,
      ats: j.ats,
      attemptId: attemptId ?? null,
      kind,
      clickedBy: clickedBy === "applypilot" ? "applypilot" : "you",
      since: iso(),
    };
    watches.set(tabId, w);
    await storage.set({ [KEYS.watch(tabId)]: w });
    if (kind !== "supervised") await rearm(tabId, w);
    if (watches.size > LIMITS.watches) {
      // A tab you aren't looking at goes first, then the oldest. Its tab closes only while it still shows that job.
      const list = [...watches.entries()].filter(([id, x]) => x.kind === "needs_you" && id !== current?.tabId && id !== tabId);
      const active = new Map();
      for (const [id] of list) active.set(id, (await tabInfo(id))?.active === true);
      const [pick] = list.sort((a, b) => Number(active.get(a[0])) - Number(active.get(b[0])) || String(a[1].since).localeCompare(String(b[1].since)));
      if (pick) {
        await removeWatch(pick[0]);
        if (await showsJob(pick[0], pick[1].jobKey)) await closeTab(pick[0]);
      }
    }
  }

  async function removeWatch(tabId) {
    if (!watches.has(tabId)) return;
    watches.delete(tabId);
    await quiet(storage.remove(KEYS.watch(tabId)));
  }

  async function rearm(tabId, w) {
    if (!(await inject(tabId))) return;
    await quiet(page(tabId, "watchForConfirmation", { ats: w.ats }, TIMES.quick));
  }

  // ---- results ----

  async function notifyResults() {
    const n = valuesWith(await storage.get(null), "apOut:").length;
    await quiet(bridge.notify("AP_RESULTS_WAITING", { n }));
  }

  function makeResult(rec, outcome, o = {}) {
    const j = rec.job;
    const clicked = outcome === "not_clicked" ? false : o.clicked === true;
    const pageUrl = typeof o.pageUrl === "string" && parseAtsUrl(o.pageUrl) ? o.pageUrl.slice(0, 1000) : "";
    return {
      resultId: uuid(),
      approvalId: j.approvalId,
      attemptId: o.attemptId ?? null,
      applicationId: j.applicationId,
      jobKey: j.jobKey,
      outcome,
      clicked,
      clickedBy: outcome === "not_clicked" ? "" : o.clickedBy || "",
      reasons: cleanReasons(o.reasons),
      pageUrl,
      confirmationText: clip(o.confirmationText, 300),
      startedAt: rec.startedAt || iso(),
      finishedAt: iso(),
      extensionVersion: version,
      confirmationKind: clip(o.confirmationKind, 30),
      // Whether the form at your click was the one ApplyPilot checked; null when ApplyPilot didn't see the click.
      fingerprintMatched: typeof o.fingerprintMatched === "boolean" ? o.fingerprintMatched : null,
    };
  }

  // Every submission Chrome knows of, by you or by ApplyPilot, so a re-approval of that job is refused even while
  // its result is still on its way to the server.
  async function ledgerFor(rec, outcome, o) {
    const j = rec.job;
    const key = KEYS.ledger(j.jobKey);
    const prev = await get1(key);
    const entry =
      isObject(prev) && prev.approvalId === j.approvalId
        ? { ...prev }
        : { clickedAt: iso(), approvalId: j.approvalId, applicationId: j.applicationId, attemptId: o.attemptId ?? null, mode: o.clickedBy === "applypilot" ? "auto" : "you" };
    if (outcome === "submitted") entry.outcome = "submitted";
    return { [key]: entry };
  }

  async function finish(rec, outcome, o = {}) {
    const result = makeResult(rec, outcome, o);
    const ledger = outcome === "submitted" || outcome === "check" ? await ledgerFor(rec, outcome, o) : {};
    rec.state = `done:${outcome}`;
    rec.reasons = result.reasons;
    rec.finishedAt = result.finishedAt;
    rec.lastResultId = result.resultId;
    rec.job = withoutPdf(rec.job);
    rec.updatedAt = iso();
    await storage.set({ [KEYS.out(result.resultId)]: result, [KEYS.job(rec.job.approvalId)]: rec, ...ledger });
    track(rec);
    emit();
    quiet(bridge.notify("AP_PROGRESS", { approvalId: rec.job.approvalId, state: rec.state, note: STATE_LABELS[rec.state] || "" }));
    await notifyResults();
    const tabId = o.tabId === undefined ? rec.tabId : o.tabId;
    if (typeof tabId === "number") {
      if (outcome === "submitted") {
        await removeWatch(tabId);
        sleep(TIMES.closeAfter).then(() => closeTab(tabId));
      } else if (outcome === "cancelled") {
        await removeWatch(tabId);
        await closeTab(tabId);
      } else await addWatch(tabId, rec, outcome, o.attemptId, o.clickedBy === "applypilot" ? "applypilot" : "you");
    }
    return result;
  }

  // Gives a claim back to the server: nothing was clicked, so the approval returns to "approved".
  async function release(rec, attemptId) {
    const result = makeResult(rec, "not_clicked", { attemptId });
    await storage.set({ [KEYS.out(result.resultId)]: result });
    await notifyResults();
    return result;
  }

  // Every result for this job must reach the server before a claim: a not_clicked from an earlier attempt, or the
  // news that you already submitted it in another tab, which revokes this approval.
  async function releasesDelivered(rec) {
    const { approvalId, jobKey } = rec.job;
    const pending = async () => valuesWith(await storage.get(null), "apOut:").some((r) => r.approvalId === approvalId || r.jobKey === jobKey);
    if (!(await pending())) return true;
    await notifyResults();
    for (let i = 0; i < TIMES.releaseTries; i++) {
      await sleep(TIMES.releasePoll);
      if (!(await pending())) return true;
    }
    return false;
  }

  // You pressed Submit in this tab yourself before ApplyPilot pressed or highlighted anything: the page said so, or
  // remembers it.
  async function youClicked(tabId, list) {
    if (early.get(tabId)?.kind === "peter_click") {
      early.delete(tabId);
      return true;
    }
    if (list.some((r) => r.code === "you_clicked")) return true;
    if (!(await inject(tabId))) return false;
    const c = await page(tabId, "clickState", undefined, TIMES.quick);
    return usable(c) && c.clicked === true;
  }

  // disarm: ApplyPilot stops waiting for your click, so the page takes back its green "everything matches".
  async function needsYou(rec, reasons, { tabId, attemptId = null, banner = true, disarm = false } = {}) {
    const list = cleanReasons(reasons);
    // That click may have sent it, so the job is locked in Chrome and goes to "check", never back for approval.
    if (typeof tabId === "number" && (await youClicked(tabId, list))) {
      return finish(rec, "check", {
        reasons: [R("you_clicked", "You pressed Submit on this page yourself. ApplyPilot couldn't confirm it went through.")],
        clicked: false,
        clickedBy: "you",
        attemptId,
        tabId,
        pageUrl: (await tabInfo(tabId))?.url || "",
      });
    }
    if ((banner || disarm) && typeof tabId === "number" && (await inject(tabId)))
      await quiet(page(tabId, disarm ? "disarm" : "bannerNeedsYou", list, TIMES.quick));
    const pageUrl = (await tabInfo(tabId))?.url || "";
    return finish(rec, "needs_you", { reasons: list, attemptId, tabId, clicked: false, pageUrl });
  }

  // You cancelled it, so its half-filled tab goes too.
  async function markCancelled(rec) {
    const tabId = rec.tabId;
    await saveJob(rec, { state: "cancelled", job: withoutPdf(rec.job), tabId: null });
    if (typeof tabId === "number") {
      await removeWatch(tabId);
      await closeTab(tabId);
    }
  }

  async function pauseRun(rec, why, extra = {}) {
    if (rec) {
      if (PRE_CLAIM.has(rec.state) || rec.state === "claiming") await closeTab(rec.tabId);
      await saveJob(rec, { state: "paused", tabId: null, attemptId: null, claim: null });
    }
    // A timed pause never outranks Stop: it would start sending again by itself.
    const reason = extra.resumeAt != null && (await isHalted()) ? "halted" : why;
    await writeRun({
      state: "paused",
      pausedReason: reason,
      pausedText: PAUSE_TEXT[reason] || "",
      resumeAt: reason === why ? extra.resumeAt ?? null : null,
      current: null,
    });
  }

  // ---- one job ----

  // The runner's own window, asked for each time: the one it started in may have closed since.
  async function newTab(url) {
    let windowId = runState.windowId;
    if (deps.currentWindowId) {
      try {
        const id = await deps.currentWindowId();
        if (typeof id === "number") windowId = id;
      } catch {}
    }
    try {
      const t = await tabs.create({ ...(typeof windowId === "number" ? { windowId } : {}), url, active: true });
      runState = { ...runState, windowId };
      return t;
    } catch (e) {
      if (typeof windowId !== "number") throw e;
      const t = await tabs.create({ url, active: true });
      runState = { ...runState, windowId: typeof t?.windowId === "number" ? t.windowId : null };
      return t;
    }
  }

  async function openForm(rec) {
    const j = rec.job;
    let last = R("form_not_found", "Couldn't find the application form.");
    let lastTab = null;
    for (const url of j.applyUrls) {
      await closeTab(lastTab);
      lastTab = null;
      await saveJob(rec, { state: "opening", tabId: null });
      const created = await newTab(url);
      const tabId = created.id;
      current.tabId = tabId;
      early.delete(tabId);
      lastTab = tabId;
      await saveJob(rec, { tabId });
      const loaded = await waitForComplete(tabId, TIMES.load);
      if (!loaded.ok) {
        if (loaded.reason === "closed") return { ok: false, tabId: null, reason: R("tab_closed", "The tab was closed before ApplyPilot finished.") };
        last = R("load_timeout", "The application page didn't finish loading.");
        continue;
      }
      const t = (await tabInfo(tabId)) || loaded.tab || {};
      if (!t.url || !isAllowedUrl(t.url)) {
        last = R("redirected", "Opens on the company's own site");
        continue;
      }
      if (parseAtsUrl(t.url)?.jobKey !== j.jobKey) {
        last = R("wrong_page", "This page isn't the job you approved.");
        continue;
      }
      if (!(await inject(tabId))) {
        last = R("form_not_found", "Couldn't read the application page.");
        continue;
      }
      const form = await page(tabId, "findForm", { ats: j.ats, timeoutMs: TIMES.form }, TIMES.form + TIMES.quick);
      if (usable(form) && form.ok === true) return { ok: true, tabId, url: t.url, form };
      const code = usable(form) && typeof form.reason === "string" && form.reason ? form.reason : "form_not_found";
      last = R(code, (usable(form) && form.text) || (code === "closed" ? "The posting looks closed." : "Couldn't find the application form."));
    }
    return { ok: false, tabId: lastTab, reason: last };
  }

  function blockersFrom(form, filled, audit, settings) {
    const out = [];
    const seen = new Set();
    const add = (b) => {
      const r = R(b.code, b.text);
      const k = `${r.code}|${r.text}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    };
    const hasCode = (code) => out.some((b) => b.code === code);
    if (!usable(filled) || !Array.isArray(filled.blockers)) add({ code: "fill_failed", text: "Couldn't fill the form." });
    else filled.blockers.filter(isObject).forEach(add);
    if (!usable(audit) || !Array.isArray(audit.blockers) || !str(audit.fingerprint, 200)) {
      add({ code: "audit_failed", text: "Couldn't check the form." });
      return out;
    }
    audit.blockers.filter(isObject).forEach(add);
    if (form.inIframe && !hasCode("form_in_iframe")) add({ code: "form_in_iframe", text: "The form is inside a frame." });
    if (form.multiStep && !hasCode("multi_step")) add({ code: "multi_step", text: "The form has more than one page." });
    if (!audit.submit && !hasCode("no_or_ambiguous_submit"))
      add({ code: "no_or_ambiguous_submit", text: "Couldn't find exactly one Submit application button." });
    const rel = Array.isArray(audit.relaxations) ? audit.relaxations : [];
    if (rel.some((x) => !RELAXATIONS.has(x))) add({ code: "audit_failed", text: "Couldn't check the form." });
    if (rel.includes("invisible_captcha") && settings.allowInvisibleCaptcha === false)
      add({ code: "captcha", text: "The page shows a CAPTCHA." });
    if (rel.includes("optional_sensitive_blank") && settings.allowOptionalSensitiveBlank === false)
      add({ code: "demographic", text: "A demographic or personal question needs you" });
    if (rel.includes("privacy_ack") && settings.allowPrivacyAck !== true)
      add({ code: "attestation", text: "The privacy-policy box is left for you (ApplyPilot's privacy-box setting is off)." });
    return out;
  }

  async function claimJob(rec, ctx) {
    const j = rec.job;
    await saveJob(rec, { state: "claiming" });
    if (await isCancelled(j.approvalId)) throw new Abort("cancelled");
    if (!(await releasesDelivered(rec))) {
      await pauseRun(rec, "dashboard");
      return null;
    }
    if (rec.settings?.auto?.[j.ats]) {
      const wait = (runState.lastAutoClaimAt || 0) + TIMES.autoSpacing - now();
      if (wait > 0) await waitEvent({ ms: wait });
    }
    let spacingTries = 0;
    for (;;) {
      if (await isHalted()) {
        await pauseRun(rec, "halted");
        return null;
      }
      const attemptId = uuid();
      // Recorded before the request, so a crash mid-claim can still give the claim back.
      await saveJob(rec, { state: "claiming", attemptId });
      const payload = {
        approvalId: j.approvalId,
        attemptId,
        applicationId: j.applicationId,
        jobKey: j.jobKey,
        resumeSha256: j.resume.sha256,
        resumeFilename: j.resume.name,
        profileHash: j.profileHash,
        pageUrl: ctx.url,
        fingerprint: ctx.fingerprint,
        relaxations: ctx.relaxations,
        fillReport: ctx.report,
        extensionVersion: version,
      };
      let res;
      try {
        res = await bridge.claim(payload);
      } catch {
        res = { ok: false, reason: "network" };
      }
      if (isObject(res) && res.ok === true) {
        if (res.mode !== "auto" && res.mode !== "supervised") {
          return { granted: false, attemptId, fail: R("claim_unclear", "ApplyPilot couldn't tell who should click Submit.") };
        }
        await saveJob(rec, { claim: { mode: res.mode, at: iso() } });
        if (res.mode === "auto") await writeRun({ lastAutoClaimAt: now() });
        return { granted: true, mode: res.mode, attemptId };
      }
      const reason = isObject(res) && typeof res.reason === "string" ? res.reason : "network";
      if (reason === "spacing") {
        const ms = Math.max(1, Math.min(3600, Number(res.retryAfterSec) || 60)) * SECOND;
        if (spacingTries < 3) {
          spacingTries++;
          await waitEvent({ ms });
          continue;
        }
        await pauseRun(rec, "spacing", { resumeAt: now() + ms });
        return null;
      }
      if (reason === "daily_cap") {
        const reset = Date.parse(res.resetAt);
        await pauseRun(rec, "daily_cap", { resumeAt: Number.isFinite(reset) ? reset : now() + DAY });
        return null;
      }
      if (TRANSPORT.has(reason)) {
        // The request may have reached the server, even when the frame that took it is gone; give the claim back in
        // case it was granted. A release for a claim never granted changes nothing there.
        await release(rec, attemptId);
        await pauseRun(rec, "dashboard");
        return null;
      }
      if (reason === "revoked" || reason === "expired") {
        await finish(rec, "cancelled", { reasons: [R(reason, DENIAL[reason])], tabId: ctx.tabId });
        return null;
      }
      await needsYou(rec, [R(reason, DENIAL[reason] || DENIAL.invalid_request)], { tabId: ctx.tabId });
      return null;
    }
  }

  async function sameUrl(tabId, url) {
    const t = await tabInfo(tabId);
    return Boolean(t && t.url === url);
  }

  async function autoSubmit(rec, ctx, attemptId) {
    const j = rec.job;
    const tabId = ctx.tabId;
    if (!(await sameUrl(tabId, ctx.url))) {
      return needsYou(rec, [R("url_changed", "The page changed after ApplyPilot checked it.")], { tabId, attemptId });
    }
    const ledgerKey = KEYS.ledger(j.jobKey);
    const previous = await get1(ledgerKey);
    rec.state = "submitting";
    rec.updatedAt = iso();
    // R9: the ledger is on disk before the click, so a crash can never lead to a second one.
    await storage.set({
      [ledgerKey]: { clickedAt: iso(), approvalId: j.approvalId, applicationId: j.applicationId, attemptId, mode: "auto" },
      [KEYS.job(j.approvalId)]: rec,
    });
    track(rec);
    emit();
    quiet(bridge.notify("AP_PROGRESS", { approvalId: j.approvalId, state: "submitting", note: STATE_LABELS.submitting }));
    let r;
    try {
      r = await page(tabId, "pressSubmit", ctx.fingerprint, TIMES.quick);
    } catch {
      r = undefined;
    }
    // Only an explicit refusal, or no page-lib in the page at all, means nothing was clicked.
    if (isObject(r) && (r.clicked === false || r.__apMissing)) {
      if (previous) await storage.set({ [ledgerKey]: previous });
      else await storage.remove(ledgerKey);
      const code = r.__apMissing ? "page_changed" : clip(r.reason, 60) || "not_clicked";
      const text = r.__apMissing ? "The page changed before ApplyPilot pressed Submit." : r.text || "ApplyPilot didn't press Submit.";
      return needsYou(rec, [R(code, text)], { tabId, attemptId });
    }
    await saveJob(rec, { state: "observing", clickedBy: "applypilot" });
    const out = await observe(rec, tabId);
    return finish(rec, out.outcome, { ...out, clicked: true, clickedBy: "applypilot", attemptId, tabId });
  }

  async function supervised(rec, ctx, attemptId) {
    const tabId = ctx.tabId;
    if (!(await sameUrl(tabId, ctx.url))) {
      return needsYou(rec, [R("url_changed", "The page changed after ApplyPilot checked it.")], { tabId, attemptId });
    }
    let armed;
    try {
      armed = await page(tabId, "armSupervised", ctx.fingerprint, TIMES.quick);
    } catch {
      armed = null;
    }
    if (!usable(armed) || armed.armed !== true) {
      const code = usable(armed) && armed.reason ? armed.reason : "not_armed";
      return needsYou(rec, [R(code, (usable(armed) && armed.text) || "Couldn't highlight the Submit button.")], { tabId, attemptId });
    }
    await focusTab(tabId);
    await saveJob(rec, { state: "waiting_for_you", waitingSince: iso(), attemptId });
    await addWatch(tabId, rec, "supervised", attemptId);
    return waitForPeter(rec, tabId, attemptId, TIMES.supervised);
  }

  async function waitForPeter(rec, tabId, attemptId, ms) {
    const j = rec.job;
    waiting = { approvalId: j.approvalId, role: j.role, company: j.company, tabId };
    emit();
    const ev = await waitEvent({ tabId, kinds: ["peter_click", "confirmed"], ms, approvalId: j.approvalId });
    waiting = null;
    emit();
    if (ev.type === "peter_click") {
      await saveJob(rec, { state: "observing", clickedBy: "you" });
      const out = await observe(rec, tabId);
      return finish(rec, out.outcome, { ...out, clicked: false, clickedBy: "you", attemptId, tabId, fingerprintMatched: ev.matches === true });
    }
    if (ev.type === "confirmed") {
      return finish(rec, "submitted", {
        clicked: false,
        clickedBy: "you",
        attemptId,
        tabId,
        fingerprintMatched: null,
        pageUrl: ev.url,
        confirmationText: ev.text,
        confirmationKind: ev.confirmationKind,
      });
    }
    if (ev.type === "closed") {
      return finish(rec, "needs_you", { reasons: [R("tab_closed", "Tab closed before you submitted")], attemptId, tabId: null });
    }
    if (ev.type === "halt") {
      return needsYou(rec, [R("stopped", "Stopped before you submitted. The form is still filled in its tab.")], { tabId, attemptId, disarm: true });
    }
    return needsYou(rec, [R(ev.type === "skip" ? "skipped" : "timeout", "You didn't submit this one")], { tabId, attemptId, disarm: true });
  }

  async function observe(rec, tabId) {
    const j = rec.job;
    const deadline = now() + TIMES.outcome;
    const silent = { outcome: "check", reasons: [R("no_confirmation", "Submit pressed, no confirmation seen")] };
    for (let i = 0; i < 20 && now() < deadline; i++) {
      let r = null;
      try {
        if (await inject(tabId)) {
          const left = Math.max(SECOND, deadline - now());
          r = await page(tabId, "readOutcome", { ats: j.ats, waitMs: left }, left + TIMES.quick);
        }
      } catch {
        r = null;
      }
      if (usable(r) && (r.outcome === "submitted" || r.outcome === "check")) {
        const out = {
          outcome: r.outcome,
          reasons: r.outcome === "check" ? [R(r.code || "no_confirmation", r.reason || "Submit pressed, no confirmation seen")] : [],
          pageUrl: typeof r.url === "string" ? r.url : "",
          confirmationText: r.confirmationText,
          confirmationKind: r.confirmationKind,
        };
        if (out.outcome === "check") await focusTab(tabId);
        return out;
      }
      if (now() >= deadline) break;
      // The click usually navigates. Give the navigation a moment to start, then read the next page.
      await sleep(TIMES.navigationStart);
      const loaded = await waitForComplete(tabId, Math.max(SECOND, deadline - now()));
      if (!loaded.ok) {
        return loaded.reason === "closed"
          ? { outcome: "check", reasons: [R("tab_closed", "The tab closed after Submit, so ApplyPilot couldn't see the result.")] }
          : silent;
      }
      const t = (await tabInfo(tabId)) || loaded.tab || {};
      if (!t.url || !isAllowedUrl(t.url)) return silent;
    }
    return silent;
  }

  async function processJob(rec) {
    const j = rec.job;
    const id = j.approvalId;
    current = { id, jobKey: j.jobKey, tabId: typeof rec.tabId === "number" ? rec.tabId : null };
    let phase = "pre_claim";
    let attemptId = null;
    let tabId = null;
    try {
      if (!rec.startedAt) rec.startedAt = iso();
      if (rec.state === "waiting_for_you") {
        phase = "claimed";
        attemptId = rec.attemptId;
        tabId = rec.tabId;
        return await resumeWaiting(rec);
      }

      // 1. Gate
      if (await isCancelled(id)) return await markCancelled(rec);
      if (await isHalted()) return await pauseRun(rec, "halted");
      if (now() >= Date.parse(j.expiresAt)) return await finish(rec, "cancelled", { reasons: [R("expired", "Approval expired")], tabId: null });
      const all = await storage.get(null);
      const refusal = ledgerRefusal(all[KEYS.ledger(j.jobKey)], j, sentApprovals(all));
      if (refusal) return await finish(rec, "needs_you", { reasons: [R("already_clicked", refusal)], tabId: null });
      for (const [watchedTab, w] of watches) {
        if (w.jobKey === j.jobKey && w.approvalId !== id && (await tabInfo(watchedTab))) {
          return await finish(rec, "needs_you", { reasons: [R("open_tab", REJECT.watch)], tabId: null });
        }
      }
      if (!(await permissions.contains({ origins: HOST_PATTERNS }))) return await pauseRun(rec, "permission");
      let pdfOk = false;
      try {
        const bytes = base64Bytes(j.resume.b64);
        pdfOk = bytes.length === j.resume.size && (await sha256(bytes)) === j.resume.sha256;
      } catch {
        pdfOk = false;
      }
      if (!pdfOk) return await finish(rec, "needs_you", { reasons: [R("resume_corrupt", "The saved resume file was damaged. Approve it again.")], tabId: null });

      // 2-4. Open the hosted form, check it's this job, find the form
      const opened = await openForm(rec);
      tabId = opened.tabId;
      if (!opened.ok) return await needsYou(rec, [opened.reason], { tabId });
      if (await isCancelled(id)) throw new Abort("cancelled");

      // 5. Fill
      await saveJob(rec, { state: "filling" });
      const filled = await page(
        tabId,
        "fill",
        {
          profile: j.profile,
          resume: j.resume,
          coverLetter: j.coverLetter,
          ats: j.ats,
          company: j.company,
          usPosting: j.usPosting === true,
          allowPrivacyAck: rec.settings?.allowPrivacyAck === true,
          budgetMs: TIMES.fillBudget,
        },
        TIMES.fill,
      );
      if (await isCancelled(id)) throw new Abort("cancelled");

      // 6. Audit (page-lib runs it twice, 1.5 s apart)
      await saveJob(rec, { state: "auditing" });
      const auditJob = { ...j, resume: { name: j.resume.name, type: j.resume.type, size: j.resume.size, sha256: j.resume.sha256 } };
      const audit = usable(filled) ? await page(tabId, "audit", { job: auditJob, settings: rec.settings }, TIMES.audit) : null;
      const blockers = blockersFrom(opened.form, filled, audit, rec.settings || {});
      if (blockers.length) return await needsYou(rec, blockers, { tabId });
      const t = await tabInfo(tabId);
      if (!t || !t.url || !isAllowedUrl(t.url) || parseAtsUrl(t.url)?.jobKey !== j.jobKey) {
        return await needsYou(rec, [R("wrong_page", "This page isn't the job you approved.")], { tabId });
      }
      const ctx = {
        tabId,
        url: t.url,
        fingerprint: audit.fingerprint,
        relaxations: [...new Set(audit.relaxations || [])],
        report: cleanReport(audit.report),
      };

      // 7. Claim, through the dashboard tab
      const claim = await claimJob(rec, ctx);
      if (!claim) return;
      attemptId = claim.attemptId;
      phase = "claimed";
      if (!claim.granted) return await needsYou(rec, [claim.fail], { tabId, attemptId });
      if ((await isHalted()) || (await isCancelled(id))) {
        await release(rec, attemptId);
        if (halted) return await pauseRun(rec, "halted");
        throw new Abort("cancelled");
      }

      // 8-11
      if (claim.mode === "auto") {
        phase = "auto";
        return await autoSubmit(rec, ctx, attemptId);
      }
      return await supervised(rec, ctx, attemptId);
    } catch (e) {
      if (e instanceof Abort && e.kind === "cancelled") return await markCancelled(rec);
      // Anything unexpected: never retry what may have been clicked.
      if (rec.state === "submitting" || rec.state === "observing") {
        return await finish(rec, "check", {
          reasons: [R("runner_error", "Something went wrong after Submit. Check this one.")],
          clicked: rec.clickedBy !== "you",
          clickedBy: rec.clickedBy === "you" ? "you" : "applypilot",
          attemptId: rec.attemptId,
          tabId,
        });
      }
      const open = (await tabInfo(tabId)) ? tabId : null;
      return await needsYou(rec, [R("runner_error", "Something went wrong while filling this one. Nothing was sent.")], {
        tabId: open,
        attemptId: phase === "pre_claim" ? null : attemptId,
      });
    } finally {
      // A click or confirmation that came in while this job was finishing belongs to the tab's watch now.
      const t = current?.tabId;
      const e = typeof t === "number" ? early.get(t) : null;
      if (e && watches.has(t)) {
        early.delete(t);
        if (e.kind === "confirmed") watchSerial(() => watchConfirmed(t, e));
        if (e.kind === "peter_click") watchSerial(() => watchClicked(t));
      }
      current = null;
      emit();
    }
  }

  async function resumeWaiting(rec) {
    // Your click may have reached this tab's watch while nothing waited for it, and finished the job already.
    await watchQueue;
    const latest = await get1(KEYS.job(rec.job.approvalId));
    if (!isObject(latest) || latest.state !== "waiting_for_you") return;
    const tabId = rec.tabId;
    current.tabId = tabId;
    if (!(await tabInfo(tabId))) {
      return finish(rec, "needs_you", { reasons: [R("tab_closed", "Tab closed before you submitted")], attemptId: rec.attemptId, tabId: null });
    }
    // Or you clicked while the runner was closed: the page remembers it.
    if (await inject(tabId)) {
      const c = await page(tabId, "clickState", undefined, TIMES.quick);
      if (usable(c) && c.clicked === true) {
        early.delete(tabId);
        await saveJob(rec, { state: "observing", clickedBy: "you" });
        const out = await observe(rec, tabId);
        return finish(rec, out.outcome, { ...out, clicked: false, clickedBy: "you", attemptId: rec.attemptId, tabId, fingerprintMatched: c.matches === true });
      }
    }
    if (await isHalted()) {
      return needsYou(rec, [R("stopped", "Stopped before you submitted. The form is still filled in its tab.")], {
        tabId,
        attemptId: rec.attemptId,
        disarm: true,
      });
    }
    // Peter may have submitted while the runner was closed: a confirmation already on screen ends the wait.
    if (await inject(tabId)) await quiet(page(tabId, "watchForConfirmation", { ats: rec.job.ats }, TIMES.quick));
    const left = Date.parse(rec.waitingSince) + TIMES.supervised - now();
    return waitForPeter(rec, tabId, rec.attemptId, Math.max(5 * SECOND, Number.isFinite(left) ? left : 0));
  }

  // ---- the run loop ----

  async function nextJob(skip) {
    const all = await storage.get(null);
    const list = valuesWith(all, "apJob:").filter((rec) => rec.job?.approvalId && !skip.has(rec.job.approvalId));
    for (const rec of list) {
      if (PENDING.has(rec.state) && all[KEYS.cancel(rec.job.approvalId)]) await markCancelled(rec);
    }
    const ready = list.filter((rec) => rec.state === "waiting_for_you" || (PENDING.has(rec.state) && !all[KEYS.cancel(rec.job.approvalId)]));
    ready.sort(
      (a, b) =>
        Number(b.state === "waiting_for_you") - Number(a.state === "waiting_for_you") ||
        String(a.job.approvedAt).localeCompare(String(b.job.approvedAt)) ||
        String(a.acceptedAt).localeCompare(String(b.acceptedAt)),
    );
    return ready[0] || null;
  }

  async function run({ countdown: withCountdown = true } = {}) {
    if (running) {
      wakeLater = true;
      return;
    }
    running = true;
    try {
      countdownPaused = false;
      await writeRun({ state: "running", pausedReason: "", pausedText: "", resumeAt: null });
      if (withCountdown && countdownMs > 0 && (await nextJob(new Set()))) {
        for (let left = countdownMs; left > 0; left -= SECOND) {
          countdown = Math.ceil(left / SECOND);
          emit();
          if (countdownPaused || (await isHalted())) {
            countdown = 0;
            return await pauseRun(null, halted ? "halted" : "countdown");
          }
          await sleep(Math.min(SECOND, left));
        }
        countdown = 0;
        emit();
      }
      const seen = new Set();
      for (;;) {
        if (runState.state !== "running") return;
        if (countdownPaused) return await pauseRun(null, "countdown");
        if (await isHalted()) return await pauseRun(null, "halted");
        const next = await nextJob(seen);
        if (!next) return await writeRun({ state: "idle", current: null });
        seen.add(next.job.approvalId);
        await writeRun({ current: next.job.approvalId });
        await processJob(next);
      }
    } finally {
      running = false;
      countdown = 0;
      emit();
      if (wakeLater && runState.state === "idle") {
        wakeLater = false;
        quiet(run());
      }
    }
  }

  async function recover() {
    const all = await storage.get(null);
    restored = isObject(all[KEYS.run]) ? all[KEYS.run] : null;
    runState = {
      ...runState,
      ...(isObject(all[KEYS.run]) ? all[KEYS.run] : {}),
      windowId: opts.windowId ?? runState.windowId,
      state: "idle",
      current: null,
    };
    halted = all[KEYS.halt] === true;
    for (const [key, w] of Object.entries(all)) {
      if (!key.startsWith("apWatch:") || !isObject(w)) continue;
      const tabId = Number(key.slice("apWatch:".length));
      if (await tabInfo(tabId)) watches.set(tabId, w);
      else await quiet(storage.remove(key));
    }
    for (const rec of valuesWith(all, "apJob:")) {
      const id = rec.job?.approvalId;
      if (!id) continue;
      const marked = Boolean(all[KEYS.cancel(id)]);
      const tabAlive = Boolean(await tabInfo(rec.tabId));
      if (PENDING.has(rec.state)) {
        if (marked) await markCancelled(rec);
      } else if (["opening", "filling", "auditing"].includes(rec.state)) {
        // Nothing was clicked: start this one again from the beginning.
        if (await showsJob(rec.tabId, rec.job.jobKey)) await closeTab(rec.tabId);
        await saveJob(rec, { state: marked ? "cancelled" : "queued", tabId: null, attemptId: null, claim: null });
      } else if (rec.state === "claiming") {
        if (rec.attemptId) await release(rec, rec.attemptId);
        if (await showsJob(rec.tabId, rec.job.jobKey)) await closeTab(rec.tabId);
        await saveJob(rec, { state: marked ? "cancelled" : "queued", tabId: null, attemptId: null, claim: null });
      } else if (rec.state === "submitting" || rec.state === "observing") {
        const by = rec.state === "observing" && rec.clickedBy === "you" ? "you" : "applypilot";
        await finish(rec, "check", {
          reasons: [R("interrupted", "Chrome closed while submitting — check this one")],
          clicked: by === "applypilot",
          clickedBy: by,
          attemptId: rec.attemptId,
          tabId: tabAlive ? rec.tabId : null,
        });
      } else if (rec.state === "waiting_for_you") {
        if (!tabAlive) {
          await finish(rec, "needs_you", { reasons: [R("tab_closed", "Tab closed before you submitted")], attemptId: rec.attemptId, tabId: null });
        } else if (!watches.has(rec.tabId)) await addWatch(rec.tabId, rec, "supervised", rec.attemptId);
      }
      const latest = (await storage.get(KEYS.job(id)))[KEYS.job(id)];
      if (isObject(latest)) track(latest);
    }
    for (const [tabId, w] of watches) if (w.kind !== "supervised") await rearm(tabId, w);
    await cleanup(storage, now());
    emit();
  }

  async function start() {
    if (await isHalted()) return pauseRun(null, "halted");
    // A pause with a time on it (daily limit, spacing) outlives a restart; claiming early would only be refused.
    const r = restored;
    if (r && r.state === "paused" && Number(r.resumeAt) > now() && PAUSE_TEXT[r.pausedReason]) {
      return writeRun({ state: "paused", pausedReason: r.pausedReason, pausedText: PAUSE_TEXT[r.pausedReason], resumeAt: Number(r.resumeAt) });
    }
    return run({ countdown: true });
  }

  async function resume() {
    countdownPaused = false;
    if (await isHalted()) await storage.set({ [KEYS.halt]: false });
    halted = false;
    if (running) return;
    return run({ countdown: false });
  }

  async function stop() {
    await storage.set({ [KEYS.halt]: true });
    return onHaltChanged(true);
  }

  async function onHaltChanged(value) {
    halted = value === true;
    if (halted) {
      for (const w of [...waiters]) w.resolve({ type: "halt" });
      // Also over a daily-limit or spacing pause, whose timer would otherwise start sending again.
      if (!running || runState.state === "paused") await pauseRun(null, "halted");
      emit();
      return;
    }
    if (!running && runState.state === "paused") return run({ countdown: false });
    emit();
  }

  // The timer behind a daily-limit or spacing pause. It never clears Stop; only you do.
  async function resumeAfterWait() {
    if (await isHalted()) return;
    const at = runState.resumeAt;
    if (running || runState.state !== "paused" || typeof at !== "number" || at > now() + SECOND) return;
    return run({ countdown: false });
  }

  // "Resume sending" on the dashboard. It goes out after every Approve & send too, so it only restarts a paused
  // run; an idle one starts with its countdown as usual.
  async function onResumeAsked() {
    if (!running && runState.state === "paused") return resume();
    return wake();
  }

  function pauseCountdown() {
    countdownPaused = true;
  }

  function skip(approvalId) {
    for (const w of [...waiters]) if (w.approvalId === approvalId) w.resolve({ type: "skip" });
  }

  function wake() {
    if (runState.state === "idle" && !running) return run({ countdown: true });
    if (running) wakeLater = true;
    return refreshJobs();
  }

  async function refreshJobs() {
    for (const rec of valuesWith(await storage.get(null), "apJob:")) if (rec.job?.approvalId) track(rec);
    emit();
  }

  async function onCancelMarked(approvalId) {
    if (current?.id === approvalId) return; // the job's own checkpoints handle it
    const rec = await get1(KEYS.job(approvalId));
    if (isObject(rec) && PENDING.has(rec.state)) await markCancelled(rec);
  }

  function onDashboardConnected() {
    if (!running && runState.state === "paused" && runState.pausedReason === "dashboard") return run({ countdown: false });
  }

  // AP_PAGE_EVENT from page-lib, trusted only from a tab this runner opened, on an ATS host.
  function onPageEvent(msg, sender) {
    const tabId = sender?.tab?.id;
    if (!isObject(msg) || typeof tabId !== "number" || !isAllowedUrl(String(sender.url || ""))) return false;
    if (!["confirmed", "peter_click", "challenge"].includes(msg.kind)) return false;
    const isCurrent = current?.tabId === tabId;
    if (!isCurrent && !watches.has(tabId)) return false;
    // A click or confirmation counts only on the page of the job that tab belongs to; Peter may have browsed elsewhere.
    const expected = watches.get(tabId)?.jobKey ?? (isCurrent ? current.jobKey : null);
    if (msg.kind !== "challenge" && parseAtsUrl(String(sender.url))?.jobKey !== expected) return false;
    const ev = {
      kind: msg.kind,
      url: String(sender.url),
      text: clip(msg.text, 300),
      fingerprint: clip(msg.fingerprint, 200),
      confirmationKind: clip(msg.confirmationKind, 30),
      matches: msg.matches === true,
    };
    let delivered = false;
    for (const w of [...waiters]) {
      if (w.tabId === tabId && w.kinds.includes(ev.kind)) {
        w.resolve({ type: ev.kind, ...ev });
        delivered = true;
      }
    }
    if (delivered) return true;
    if (isCurrent) {
      if (ev.kind === "peter_click" || ev.kind === "confirmed") early.set(tabId, ev);
      if (ev.kind === "challenge") quiet(focusTab(tabId));
      return true;
    }
    // One at a time, so a confirmation that follows your click never races the click's own record.
    if (ev.kind === "confirmed") watchSerial(() => watchConfirmed(tabId, ev));
    if (ev.kind === "peter_click") watchSerial(() => watchClicked(tabId));
    return true;
  }
  let watchQueue = Promise.resolve();
  const watchSerial = (fn) => (watchQueue = watchQueue.then(fn).catch(() => {}));

  // You pressed Submit in a watched tab, so a confirmation that follows is yours, not ApplyPilot's. That click may
  // have sent the application even when no confirmation ApplyPilot knows follows, so the job is locked in Chrome
  // and goes to "check" on the dashboard at once, not when the tab closes (the runner may be shut by then). The same
  // holds in a supervised tab whose wait wasn't listening. Every click counts: after "It didn't go through" you may
  // fix the form and press Submit again, and that is news for the server too.
  async function watchClicked(tabId) {
    const w = watches.get(tabId);
    if (!w) return;
    w.clickedBy = "you";
    w.peterClicked = true;
    const supervisedTab = w.kind === "supervised";
    if (supervisedTab) w.kind = "check";
    const key = KEYS.job(w.approvalId);
    const rec = (await storage.get(key))[key];
    const o = { clicked: false, clickedBy: "you", attemptId: w.attemptId ?? null, pageUrl: (await tabInfo(tabId))?.url || "" };
    const writes = { [KEYS.watch(tabId)]: w };
    let result = null;
    if (isObject(rec) && rec.job && ["done:needs_you", "done:check", "waiting_for_you"].includes(rec.state)) {
      const ledger = await ledgerFor(rec, "check", o);
      for (const entry of Object.values(ledger)) entry.clickedAt = iso();
      Object.assign(writes, ledger);
      // A "check" still on its way to the server already says so.
      const unsent = rec.state === "done:check" && rec.lastResultId && isObject(await get1(KEYS.out(rec.lastResultId)));
      if (!unsent) {
        const reasons = [R("you_clicked", "You clicked Submit in the open tab. ApplyPilot couldn't confirm it went through.")];
        result = makeResult(rec, "check", { ...o, reasons });
        const next = { ...rec, state: "done:check", reasons: result.reasons, finishedAt: result.finishedAt, lastResultId: result.resultId, updatedAt: iso() };
        if (next.job?.resume?.b64) next.job = withoutPdf(next.job);
        writes[KEYS.out(result.resultId)] = result;
        writes[key] = next;
        track(next);
      }
    }
    await quiet(storage.set(writes));
    if (result) {
      emit();
      await notifyResults();
    }
    if (supervisedTab) await rearm(tabId, w);
  }

  // Peter finished a needs-you, check or skipped tab himself: record the real outcome.
  async function watchConfirmed(tabId, ev) {
    const w = watches.get(tabId);
    if (!w) return;
    watches.delete(tabId);
    await quiet(storage.remove(KEYS.watch(tabId)));
    const key = KEYS.job(w.approvalId);
    const rec = (await storage.get(key))[key];
    if (!isObject(rec) || !rec.job) return;
    const by = w.clickedBy === "applypilot" ? "applypilot" : "you";
    const o = {
      clicked: by === "applypilot",
      clickedBy: by,
      attemptId: w.attemptId ?? null,
      pageUrl: ev.url,
      confirmationText: ev.text,
      confirmationKind: ev.confirmationKind,
      fingerprintMatched: false,
    };
    const result = makeResult(rec, "submitted", o);
    const next = { ...rec, state: "done:submitted", reasons: [], finishedAt: result.finishedAt, lastResultId: result.resultId, updatedAt: iso() };
    await storage.set({ [KEYS.out(result.resultId)]: result, [key]: next, ...(await ledgerFor(rec, "submitted", o)) });
    track(next);
    emit();
    await notifyResults();
  }

  function onTabUpdated(tabId, info) {
    if (!info || info.status !== "complete") return;
    const w = watches.get(tabId);
    // The running job reads its own outcome, except while it waits for Peter's click.
    if (w && (current?.tabId !== tabId || waiting?.tabId === tabId)) quiet(rearm(tabId, w));
  }

  function onTabRemoved(tabId) {
    for (const w of [...waiters]) if (w.tabId === tabId) w.resolve({ type: "closed" });
    early.delete(tabId);
    if (watches.has(tabId)) quiet(removeWatch(tabId));
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(view());
    return () => listeners.delete(fn);
  }

  return {
    recover,
    start,
    run,
    resume,
    resumeAfterWait,
    onResumeAsked,
    stop,
    skip,
    wake,
    pauseCountdown,
    processJob,
    onHaltChanged,
    onCancelMarked,
    onDashboardConnected,
    onPageEvent,
    onTabUpdated,
    onTabRemoved,
    subscribe,
    view,
  };
}
