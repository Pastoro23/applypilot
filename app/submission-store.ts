import type { SqlDatabase, SqlStatement } from "./ai-operations.ts";
import { applyTarget, applyUrlsFor, isApplyTarget, isAts, parseAtsUrl, type ApplyTarget, type Ats } from "./apply-target.ts";
import { UserFacingError } from "./errors.ts";
import { autofillProfileFromRow, buildAutofillProfile, profileHash } from "./profile-records.ts";

// Approvals to submit jobs, the single-use claim made right before Submit, and the results the extension reports.
// Every state change is one guarded UPDATE, so a stale or repeated request can't move a row the wrong way.

export const MAX_APPROVE = 20;
export const MAX_RESULTS = 20;
export const APPROVAL_MS = 24 * 3_600_000;
export const STALE_CLAIM_MS = 15 * 60_000;
// A supervised claim waits up to 30 minutes for your click, plus the outcome check, so it goes stale later.
export const STALE_SUPERVISED_CLAIM_MS = 35 * 60_000;
export const staleAfterMs = (claimMode: string) => (claimMode === "supervised" ? STALE_SUPERVISED_CLAIM_MS : STALE_CLAIM_MS);
export const CALIBRATION_NEEDED = 3;
export const DAILY_CAP_MAX = 25;
const AUTO_SPACING_MS = 60_000;
const DAY_MS = 86_400_000;
const LIST_WINDOW_MS = 30 * DAY_MS;
const LIST_LIMIT = 200;
const MAX_DETAIL = 4096;
const ATS_LIST: Ats[] = ["greenhouse", "lever", "ashby"];
const ATS_NAMES: Record<Ats, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

export type SubmissionState = "approved" | "claimed" | "submitted" | "needs_you" | "check" | "not_sent" | "revoked" | "expired";
export type Relaxation = "invisible_captcha" | "optional_sensitive_blank" | "privacy_ack";
export type Reason = { code: string; text: string };
export type FillReportEntry = { label: string; type: string; required: boolean; value: string; source: string };
export type SubmitSettings = {
  auto: Record<Ats, boolean>; dailyCap: number; allowInvisibleCaptcha: boolean; allowOptionalSensitiveBlank: boolean;
  allowPrivacyAck: boolean;
};
export type Calibration = Record<Ats, number>;
export type ApprovedItem = {
  approvalId: string; applicationId: string; jobKey: string; ats: Ats; applyUrls: string[]; revision: number;
  profileHash: string; includeCoverLetter: boolean; supersedesId: string | null; approvedAt: string; expiresAt: string;
};
export type SkippedItem = { applicationId: string; code: string; reason: string };
export type SubmissionRow = {
  id: string; applicationId: string; jobKey: string; ats: Ats; applyUrl: string; applyUrls: string[];
  tailoredRevision: number; profileHash: string; includeCoverLetter: boolean; supersedesId: string | null;
  state: SubmissionState; reason: string; reasons: Reason[]; approvedAt: string; expiresAt: string;
  attemptId: string | null; claimMode: "" | "auto" | "supervised"; claimedAt: string | null; relaxations: string[];
  clickedBy: "" | "applypilot" | "you"; resumeSha256: string; resumeFilename: string; pageUrl: string;
  confirmationText: string; finishedAt: string | null; extensionVersion: string; updatedAt: string;
  fillReport?: FillReportEntry[];
};
export type ClaimRequest = {
  approvalId: string; attemptId: string; applicationId: string; jobKey: string; resumeSha256: string; resumeFilename: string;
  profileHash: string; pageUrl: string; fingerprint: string; relaxations: Relaxation[]; fillReport: FillReportEntry[];
  extensionVersion: string;
};
export type ClaimResult =
  | { ok: true; mode: "auto" | "supervised" }
  | { ok: false; reason: string; retryAfterSec?: number; resetAt?: string };
export type ResultOutcome = "submitted" | "needs_you" | "check" | "not_clicked" | "cancelled";
export type SubmissionResult = {
  resultId: string; approvalId: string; attemptId: string | null; applicationId: string; jobKey: string;
  outcome: ResultOutcome; clicked: boolean; clickedBy: "" | "applypilot" | "you"; reasons: Reason[]; pageUrl: string;
  confirmationText: string; startedAt: string; finishedAt: string; extensionVersion: string; confirmationKind: string;
  fingerprintMatched: boolean | null;
};

export const defaultSettings: SubmitSettings = {
  auto: { greenhouse: false, lever: false, ashby: false },
  dailyCap: 10,
  // Peter chose "Skip both" on 2026-10-26; either can be turned off in Extension settings.
  allowInvisibleCaptcha: true,
  allowOptionalSensitiveBlank: true,
  // Peter chose "Tick them" on 2026-10-26: a required box that only acknowledges a privacy policy may be ticked.
  allowPrivacyAck: true,
};

type DbRow = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const LIVE = "('approved','claimed','check')";
const OPEN_APP = "('saved','ready')";
const iso = (ms: number) => new Date(ms).toISOString();
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const invalid = () => new UserFacingError("The request was not valid.", 400);

function detailJson(value: Record<string, unknown>) {
  const json = JSON.stringify(value);
  if (json.length <= MAX_DETAIL) return json;
  const small = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "object" || v === null));
  const trimmed = JSON.stringify({ ...small, truncated: true });
  return trimmed.length <= MAX_DETAIL ? trimmed : JSON.stringify({ truncated: true });
}

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function cleanReasons(value: unknown): Reason[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).slice(0, 10)
    .map((reason) => ({ code: text(reason.code, 60), text: text(reason.text, 200) }))
    .filter((reason) => reason.code || reason.text);
}

function cleanFillReport(value: unknown): FillReportEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).slice(0, 60).map((entry) => ({
    label: text(entry.label, 200), type: text(entry.type, 40), required: entry.required === true,
    value: text(entry.value, 500), source: text(entry.source, 40),
  }));
}

// The stored first candidate rebuilds the whole list, the same way the approval made it.
function candidatesFrom(applyUrl: string) {
  const parsed = parseAtsUrl(applyUrl);
  if (!parsed) return [applyUrl];
  return applyUrlsFor(parsed.ats, parsed.board, parsed.jobId, applyUrl.startsWith("https://jobs.eu.lever.co/"));
}

const ROW_COLUMNS = `id, application_id, job_key, ats, apply_url, tailored_revision, profile_hash, include_cover_letter,
  supersedes_id, state, reason, reasons_json, approved_at, expires_at, attempt_id, claim_mode, claimed_at, relaxations,
  clicked_by, resume_sha256, resume_filename, page_url, confirmation_text, finished_at, extension_version, updated_at`;

function toRow(r: DbRow): SubmissionRow {
  const applyUrl = String(r.apply_url ?? "");
  const row: SubmissionRow = {
    id: String(r.id),
    applicationId: String(r.application_id),
    jobKey: String(r.job_key),
    ats: r.ats as Ats,
    applyUrl,
    applyUrls: candidatesFrom(applyUrl),
    tailoredRevision: Number(r.tailored_revision),
    profileHash: String(r.profile_hash),
    includeCoverLetter: Number(r.include_cover_letter) === 1,
    supersedesId: typeof r.supersedes_id === "string" ? r.supersedes_id : null,
    state: r.state as SubmissionState,
    reason: String(r.reason ?? ""),
    reasons: cleanReasons(parseJson(r.reasons_json, [])),
    approvedAt: String(r.approved_at),
    expiresAt: String(r.expires_at),
    attemptId: typeof r.attempt_id === "string" ? r.attempt_id : null,
    claimMode: (r.claim_mode ?? "") as SubmissionRow["claimMode"],
    claimedAt: typeof r.claimed_at === "string" ? r.claimed_at : null,
    relaxations: String(r.relaxations ?? "").split(",").filter(Boolean),
    clickedBy: (r.clicked_by ?? "") as SubmissionRow["clickedBy"],
    resumeSha256: String(r.resume_sha256 ?? ""),
    resumeFilename: String(r.resume_filename ?? ""),
    pageUrl: String(r.page_url ?? ""),
    confirmationText: String(r.confirmation_text ?? ""),
    finishedAt: typeof r.finished_at === "string" ? r.finished_at : null,
    extensionVersion: String(r.extension_version ?? ""),
    updatedAt: String(r.updated_at),
  };
  if ("fill_report_json" in r) row.fillReport = cleanFillReport(parseJson(r.fill_report_json, []));
  return row;
}

// For the dashboard's "Start sending" banner: an approved row rebuilt as the item the batch needs.
export function approvedItemFromRow(row: SubmissionRow): ApprovedItem {
  return {
    approvalId: row.id, applicationId: row.applicationId, jobKey: row.jobKey, ats: row.ats, applyUrls: row.applyUrls,
    revision: row.tailoredRevision, profileHash: row.profileHash, includeCoverLetter: row.includeCoverLetter,
    supersedesId: row.supersedesId, approvedAt: row.approvedAt, expiresAt: row.expiresAt,
  };
}

export function parseSettings(value: unknown): SubmitSettings {
  const raw = isObject(value) ? value : parseJson(value, {});
  const saved = isObject(raw) ? raw : {};
  const auto = isObject(saved.auto) ? saved.auto : {};
  const cap = saved.dailyCap;
  return {
    auto: { greenhouse: auto.greenhouse === true, lever: auto.lever === true, ashby: auto.ashby === true },
    dailyCap: typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= DAILY_CAP_MAX ? cap : defaultSettings.dailyCap,
    allowInvisibleCaptcha: saved.allowInvisibleCaptcha !== false,
    allowOptionalSensitiveBlank: saved.allowOptionalSensitiveBlank !== false,
    allowPrivacyAck: saved.allowPrivacyAck !== false,
  };
}

function checkSettings(value: unknown): SubmitSettings {
  if (!isObject(value) || !isObject(value.auto)) throw invalid();
  const auto = value.auto;
  const cap = value.dailyCap;
  if (!ATS_LIST.every((ats) => typeof auto[ats] === "boolean")) throw invalid();
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > DAILY_CAP_MAX) throw invalid();
  if (typeof value.allowInvisibleCaptcha !== "boolean" || typeof value.allowOptionalSensitiveBlank !== "boolean") throw invalid();
  if (value.allowPrivacyAck !== undefined && typeof value.allowPrivacyAck !== "boolean") throw invalid();
  return {
    auto: { greenhouse: auto.greenhouse === true, lever: auto.lever === true, ashby: auto.ashby === true },
    dailyCap: cap,
    allowInvisibleCaptcha: value.allowInvisibleCaptcha,
    allowOptionalSensitiveBlank: value.allowOptionalSensitiveBlank,
    allowPrivacyAck: value.allowPrivacyAck !== false,
  };
}

const NOT_CONFIRMED = "Confirm your name, location and work history on your profile first.";

function profileReady(p: DbRow | undefined | null): p is DbRow {
  return Boolean(p && p.identity_status === "confirmed" && p.location_status === "confirmed" &&
    p.work_history_status === "confirmed" && text(p.first_name, 200) && text(p.last_name, 200) && text(p.profile_email, 300));
}

const hashOfRow = (p: DbRow) => profileHash(buildAutofillProfile(autofillProfileFromRow(p)));

// Expired approvals are swept before anything reads or claims them; each gets one 'expired' event.
function sweep(db: SqlDatabase, owner: string, nowIso: string): SqlStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT id || ':expired', owner_email, id, ?, 'server', 'expired', '{}' FROM submissions
      WHERE owner_email = ? AND state = 'approved' AND expires_at <= ?`).bind(nowIso, owner, nowIso),
    db.prepare(`UPDATE submissions SET state = 'expired', reason = 'Approval expired', updated_at = ?
      WHERE owner_email = ? AND state = 'approved' AND expires_at <= ?`).bind(nowIso, owner, nowIso),
  ];
}

function revoke(db: SqlDatabase, owner: string, id: string, reason: string, actor: string, nowIso: string): SqlStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT id || ':revoked', owner_email, id, ?, ?, 'revoked', ? FROM submissions WHERE id = ? AND owner_email = ? AND state = 'approved'`)
      .bind(nowIso, actor, JSON.stringify({ reason }), id, owner),
    db.prepare("UPDATE submissions SET state = 'revoked', reason = ?, updated_at = ? WHERE id = ? AND owner_email = ? AND state = 'approved'")
      .bind(reason, nowIso, id, owner),
  ];
}

// Supervised submissions Peter clicked himself and ApplyPilot saw confirmed; 3 on an ATS unlock automatic clicks there.
// Only a claim that went straight to submitted on such a result counts ('calibrated'), never one resolved by hand,
// finished in a needs-you tab, or clicked on a form that no longer matched ApplyPilot's check.
const CALIBRATION = `cal AS (SELECT sum(s.ats = 'greenhouse') AS cal_greenhouse, sum(s.ats = 'lever') AS cal_lever, sum(s.ats = 'ashby') AS cal_ashby
  FROM submissions s WHERE s.owner_email = ? AND s.state = 'submitted' AND s.claim_mode = 'supervised' AND s.clicked_by = 'you'
    AND EXISTS (SELECT 1 FROM submission_events e WHERE e.owner_email = s.owner_email AND e.submission_id = s.id AND e.event = 'calibrated'))`;
const calibrationOf = (r: DbRow | undefined | null): Calibration => ({
  greenhouse: Number(r?.cal_greenhouse ?? 0), lever: Number(r?.cal_lever ?? 0), ashby: Number(r?.cal_ashby ?? 0),
});

type JobJoin = { app_id: string; app_status: string; app_url: string; app_tailored: unknown; app_revision: unknown;
  found_kind: string | null; found_external_id: string | null; source_token: string | null };
const targetOf = (j: JobJoin) =>
  applyTarget({ url: j.app_url ?? "", kind: j.found_kind, token: j.source_token, externalId: j.found_external_id });

// One row per application, preferring the found-job row that still has its board token.
function byApplication(rows: DbRow[]) {
  const out = new Map<string, JobJoin>();
  for (const row of rows) {
    const job = row as unknown as JobJoin;
    if (typeof job.app_id !== "string") continue;
    if (!out.has(job.app_id) || job.source_token) out.set(job.app_id, job);
  }
  return out;
}

function checkItems(items: unknown) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_APPROVE) {
    throw new UserFacingError(`Choose 1 to ${MAX_APPROVE} jobs to approve.`, 400);
  }
  const list = items.map((item) => {
    if (!isObject(item)) throw invalid();
    const applicationId = text(item.applicationId, 80);
    if (!applicationId || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw invalid();
    return { applicationId, revision: item.revision as number };
  });
  if (new Set(list.map((item) => item.applicationId)).size !== list.length) throw invalid();
  return list;
}

export async function approveForSubmit(
  db: SqlDatabase, owner: string, items: unknown, opts: { includeCoverLetter: unknown; now?: number },
): Promise<{ approved: ApprovedItem[]; skipped: SkippedItem[]; replaced: string[] }> {
  const list = checkItems(items);
  if (typeof opts.includeCoverLetter !== "boolean") throw invalid();
  const includeCoverLetter = opts.includeCoverLetter;
  const now = opts.now ?? Date.now();
  const nowIso = iso(now);
  const ids = list.map((item) => item.applicationId);

  const joined = (await db.prepare(`SELECT p.*, a.id AS app_id, a.status AS app_status, a.url AS app_url,
      a.tailored_json IS NOT NULL AS app_tailored, a.tailored_revision AS app_revision,
      f.kind AS found_kind, f.external_id AS found_external_id, j.token AS source_token
    FROM profiles p
    LEFT JOIN applications a ON a.owner_email = p.owner_email AND a.id IN (${marks(ids.length)})
    LEFT JOIN found_jobs f ON f.application_id = a.id AND f.owner_email = a.owner_email
    LEFT JOIN job_sources j ON j.id = f.source_id AND j.owner_email = a.owner_email
    WHERE p.owner_email = ?`).bind(...ids, owner).all<DbRow>()).results;
  const profile = joined[0];
  if (!profileReady(profile)) throw new UserFacingError(NOT_CONFIRMED, 400);
  const hash = await hashOfRow(profile);
  const apps = byApplication(joined);
  const targets = new Map(ids.map((id) => [id, apps.has(id) ? targetOf(apps.get(id)!) : undefined]));
  const keys = [...new Set([...targets.values()].filter(isApplyTarget).map((target) => target.jobKey))];

  const existing = (await db.prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE owner_email = ?
      AND state IN ('approved','claimed','check','submitted','not_sent')
      AND (application_id IN (${marks(ids.length)})${keys.length ? ` OR job_key IN (${marks(keys.length)})` : ""})
      ORDER BY updated_at DESC`).bind(owner, ...ids, ...keys).all<DbRow>()).results;

  const approved: ApprovedItem[] = [];
  const skipped: SkippedItem[] = [];
  const statements: SqlStatement[] = [...sweep(db, owner, nowIso)];
  const inserts: { index: number; item: ApprovedItem }[] = [];
  const revokes: { index: number; id: string }[] = [];
  const handled = new Set<string>();
  const skip = (applicationId: string, code: string, reason: string) => skipped.push({ applicationId, code, reason });

  for (const item of list) {
    const app = apps.get(item.applicationId);
    const target = targets.get(item.applicationId);
    if (!app) { skip(item.applicationId, "not_found", "This job is no longer in your list."); continue; }
    if (!Number(app.app_tailored)) { skip(item.applicationId, "not_tailored", "Make the tailored resume first"); continue; }
    if (Number(app.app_revision) !== item.revision) { skip(item.applicationId, "resume_changed", "The resume changed. Review it again."); continue; }
    if (app.app_status !== "saved" && app.app_status !== "ready") {
      skip(item.applicationId, "final_status", `Already marked ${app.app_status}`);
      continue;
    }
    if (!isApplyTarget(target)) { skip(item.applicationId, "unsupported_site", target?.reason ?? "Apply yourself"); continue; }
    if (handled.has(target.jobKey)) { skip(item.applicationId, "duplicate", "The same job is already in this list"); continue; }
    handled.add(target.jobKey);
    const related = existing.filter((r) => r.job_key === target.jobKey || r.application_id === item.applicationId);
    if (related.some((r) => r.state === "submitted" && r.job_key === target.jobKey)) {
      skip(item.applicationId, "already_submitted", "Already submitted");
      continue;
    }
    if (related.some((r) => r.state === "claimed" || r.state === "check")) {
      skip(item.applicationId, "in_progress", "ApplyPilot is sending this or needs you to check it");
      continue;
    }
    const live = related.filter((r) => r.state === "approved");
    const fresh = live.find((r) => r.application_id === item.applicationId && r.job_key === target.jobKey &&
      Number(r.tailored_revision) === item.revision && r.profile_hash === hash &&
      (Number(r.include_cover_letter) === 1) === includeCoverLetter && String(r.expires_at) > nowIso);
    for (const stale of live) {
      if (stale === fresh) continue;
      statements.push(...revoke(db, owner, String(stale.id), "Replaced by a new approval", "peter", nowIso));
      revokes.push({ index: statements.length - 1, id: String(stale.id) });
    }
    if (fresh) {
      approved.push({ ...approvedItemFromRow(toRow(fresh)), applyUrls: target.applyUrls });
      continue;
    }
    const supersedes = existing.find((r) => r.state === "not_sent" && r.job_key === target.jobKey);
    const next: ApprovedItem = {
      approvalId: crypto.randomUUID(), applicationId: item.applicationId, jobKey: target.jobKey, ats: target.ats,
      applyUrls: target.applyUrls, revision: item.revision, profileHash: hash, includeCoverLetter,
      supersedesId: supersedes ? String(supersedes.id) : null, approvedAt: nowIso, expiresAt: iso(now + APPROVAL_MS),
    };
    // Re-checked in the write itself, so an edit or a submission between the read and here still wins.
    statements.push(db.prepare(`INSERT OR IGNORE INTO submissions (id, owner_email, application_id, job_key, ats, apply_url,
        tailored_revision, profile_hash, include_cover_letter, supersedes_id, state, approved_at, expires_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM applications WHERE id = ? AND owner_email = ? AND tailored_revision = ?
          AND tailored_json IS NOT NULL AND status IN ${OPEN_APP})
        AND NOT EXISTS (SELECT 1 FROM submissions WHERE owner_email = ? AND job_key = ? AND state = 'submitted')`)
      .bind(next.approvalId, owner, next.applicationId, next.jobKey, next.ats, next.applyUrls[0], next.revision, hash,
        includeCoverLetter ? 1 : 0, next.supersedesId, nowIso, next.expiresAt, nowIso,
        next.applicationId, owner, next.revision, owner, next.jobKey));
    inserts.push({ index: statements.length - 1, item: next });
    statements.push(db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, ?, ?, ?, 'peter', 'approved', ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND owner_email = ?)`)
      .bind(crypto.randomUUID(), owner, next.approvalId, nowIso,
        detailJson({ jobKey: next.jobKey, revision: next.revision, profileHash: hash, includeCoverLetter, supersedesId: next.supersedesId }),
        next.approvalId, owner));
    approved.push(next);
  }

  const results = await db.batch(statements);
  const lost = new Set<string>();
  for (const { index, item } of inserts) {
    if (results[index]?.meta.changes !== 1) {
      lost.add(item.approvalId);
      skip(item.applicationId, "in_progress", "ApplyPilot is sending this or needs you to check it");
    }
  }
  // The dashboard cancels these in Chrome too, or Chrome would refuse the new approval as a duplicate.
  const replaced = revokes.filter(({ index }) => results[index]?.meta.changes === 1).map(({ id }) => id);
  return { approved: approved.filter((item) => !lost.has(item.approvalId)), skipped, replaced };
}

function checkClaim(value: unknown): ClaimRequest | null {
  if (!isObject(value)) return null;
  const relaxations = value.relaxations;
  if (!Array.isArray(relaxations) || relaxations.length > 3 ||
    !relaxations.every((r) => r === "invisible_captcha" || r === "optional_sensitive_blank" || r === "privacy_ack") ||
    new Set(relaxations).size !== relaxations.length) return null;
  if (!Array.isArray(value.fillReport)) return null;
  const req: ClaimRequest = {
    approvalId: text(value.approvalId, 40), attemptId: text(value.attemptId, 40), applicationId: text(value.applicationId, 80),
    jobKey: text(value.jobKey, 200), resumeSha256: text(value.resumeSha256, 64), resumeFilename: text(value.resumeFilename, 200),
    profileHash: text(value.profileHash, 64), pageUrl: text(value.pageUrl, 1000), fingerprint: text(value.fingerprint, 100),
    relaxations: relaxations as Relaxation[], fillReport: cleanFillReport(value.fillReport),
    extensionVersion: text(value.extensionVersion, 20),
  };
  if (!UUID.test(req.approvalId) || !UUID.test(req.attemptId) || !req.applicationId || !req.jobKey) return null;
  if (!HEX64.test(req.resumeSha256) || !HEX64.test(req.profileHash) || !req.resumeFilename) return null;
  return req;
}

type ClaimFacts = DbRow & {
  sub_id: string | null; sub_application_id: string | null; sub_job_key: string | null; sub_ats: string | null;
  sub_state: string | null; sub_expires_at: string | null; sub_profile_hash: string | null; sub_revision: unknown;
  sub_attempt_id: string | null; sub_claim_mode: string | null; attempt_closed: unknown;
  app_id: string | null; app_revision: unknown; app_status: string | null; submitted_exists: unknown;
  auto_count: unknown; auto_oldest: string | null; auto_last: string | null;
};

async function claimFacts(db: SqlDatabase, owner: string, req: ClaimRequest, now: number) {
  const dayAgo = iso(now - DAY_MS);
  return db.prepare(`WITH ${CALIBRATION}
    SELECT p.*, cal.*, s.id AS sub_id, s.application_id AS sub_application_id, s.job_key AS sub_job_key, s.ats AS sub_ats,
      s.state AS sub_state, s.expires_at AS sub_expires_at, s.profile_hash AS sub_profile_hash, s.tailored_revision AS sub_revision,
      s.attempt_id AS sub_attempt_id, s.claim_mode AS sub_claim_mode,
      EXISTS (${resultForAttempt("o.owner", "s.id")}) AS attempt_closed,
      a.id AS app_id, a.tailored_revision AS app_revision, a.status AS app_status,
      EXISTS (SELECT 1 FROM submissions x WHERE x.owner_email = o.owner AND x.job_key = ? AND x.state = 'submitted') AS submitted_exists,
      (SELECT count(*) FROM submissions c WHERE c.owner_email = o.owner AND c.claim_mode = 'auto' AND c.claimed_at > ?) AS auto_count,
      (SELECT min(c.claimed_at) FROM submissions c WHERE c.owner_email = o.owner AND c.claim_mode = 'auto' AND c.claimed_at > ?) AS auto_oldest,
      (SELECT max(c.claimed_at) FROM submissions c WHERE c.owner_email = o.owner AND c.claim_mode = 'auto') AS auto_last
    FROM (SELECT ? AS owner) o CROSS JOIN cal
    LEFT JOIN profiles p ON p.owner_email = o.owner
    LEFT JOIN submissions s ON s.id = ? AND s.owner_email = o.owner
    LEFT JOIN applications a ON a.id = s.application_id AND a.owner_email = o.owner`)
    .bind(owner, req.attemptId, req.jobKey, dayAgo, dayAgo, owner, req.approvalId).first<ClaimFacts>();
}

type Denial = { ok: false; reason: string; retryAfterSec?: number; resetAt?: string };

// An attempt Chrome already reported a result for (usually the not_clicked that gave it back) is closed: a copy of its
// claim that arrives late is refused.
const resultForAttempt = (ownerSql: string, idSql: string) => `SELECT 1 FROM submission_events r WHERE r.owner_email = ${ownerSql}
  AND r.submission_id = ${idSql} AND r.event LIKE 'result:%' AND json_extract(r.detail_json, '$.attemptId') = ?`;

// The same conditions as the claim UPDATE, read back so the runner learns why it may not go on.
function denialFrom(f: ClaimFacts | null, req: ClaimRequest, settings: SubmitSettings, mode: string, currentHash: string, now: number): Denial | null {
  const nowIso = iso(now);
  if (!f?.sub_id || f.sub_application_id !== req.applicationId || f.sub_job_key !== req.jobKey) return { ok: false, reason: "not_found" };
  if (f.sub_state === "revoked") return { ok: false, reason: "revoked" };
  if (f.sub_state === "expired" || (f.sub_state === "approved" && String(f.sub_expires_at) <= nowIso)) return { ok: false, reason: "expired" };
  if (f.sub_state === "submitted" || Number(f.submitted_exists)) return { ok: false, reason: "already_submitted" };
  if (f.sub_state !== "approved") return { ok: false, reason: "already_claimed" };
  if (Number(f.attempt_closed)) return { ok: false, reason: "attempt_closed" };
  if (f.sub_profile_hash !== currentHash) return { ok: false, reason: "profile_changed" };
  if (!f.app_id) return { ok: false, reason: "not_found" };
  if (f.app_status !== "saved" && f.app_status !== "ready") return { ok: false, reason: "status_final" };
  if (Number(f.app_revision) !== Number(f.sub_revision)) return { ok: false, reason: "resume_changed" };
  if (mode === "auto") {
    if (Number(f.auto_count) >= settings.dailyCap) {
      const oldest = Date.parse(String(f.auto_oldest));
      return { ok: false, reason: "daily_cap", resetAt: iso((Number.isFinite(oldest) ? oldest : now) + DAY_MS) };
    }
    const last = Date.parse(String(f.auto_last));
    if (Number.isFinite(last) && last > now - AUTO_SPACING_MS) {
      return { ok: false, reason: "spacing", retryAfterSec: Math.max(1, Math.ceil((last + AUTO_SPACING_MS - now) / 1000)) };
    }
  }
  return null;
}

function deniedEvent(db: SqlDatabase, owner: string, req: ClaimRequest, denial: Denial, nowIso: string) {
  return db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
    VALUES (?, ?, ?, ?, 'extension', 'claim_denied', ?)`)
    .bind(crypto.randomUUID(), owner, req.approvalId, nowIso,
      detailJson({ attemptId: req.attemptId, reason: denial.reason, retryAfterSec: denial.retryAfterSec, resetAt: denial.resetAt }));
}

// The same attempt again (Chrome tried another dashboard tab after no answer) gets the answer it was given.
function sameAttempt(f: ClaimFacts | null, req: ClaimRequest): ClaimResult | null {
  if (f?.sub_state !== "claimed" || f.sub_attempt_id !== req.attemptId) return null;
  if (f.sub_application_id !== req.applicationId || f.sub_job_key !== req.jobKey) return null;
  return f.sub_claim_mode === "auto" || f.sub_claim_mode === "supervised" ? { ok: true, mode: f.sub_claim_mode } : null;
}

export async function claimSubmission(db: SqlDatabase, owner: string, input: unknown, now = Date.now()): Promise<ClaimResult> {
  const req = checkClaim(input);
  if (!req) return { ok: false, reason: "invalid_request" };
  const nowIso = iso(now);
  const facts = await claimFacts(db, owner, req, now);
  const again = sameAttempt(facts, req);
  if (again) return again;
  const settings = parseSettings(facts?.apply_settings_json);
  const currentHash = profileReady(facts) ? await hashOfRow(facts) : "";
  const ats = facts && isAts(facts.sub_ats) ? facts.sub_ats : null;
  const mode = ats && settings.auto[ats] && calibrationOf(facts)[ats] >= CALIBRATION_NEEDED ? "auto" : "supervised";
  const deny = async (denial: Denial) => {
    await db.batch([...sweep(db, owner, nowIso), deniedEvent(db, owner, req, denial, nowIso)]);
    return denial;
  };

  if ((req.relaxations.includes("invisible_captcha") && !settings.allowInvisibleCaptcha) ||
    (req.relaxations.includes("optional_sensitive_blank") && !settings.allowOptionalSensitiveBlank) ||
    (req.relaxations.includes("privacy_ack") && !settings.allowPrivacyAck)) {
    return deny({ ok: false, reason: "setting_changed" });
  }
  if (!currentHash || req.profileHash !== currentHash) return deny({ ok: false, reason: "profile_changed" });
  if (parseAtsUrl(req.pageUrl)?.jobKey !== req.jobKey) return deny({ ok: false, reason: "wrong_page" });
  const predicted = denialFrom(facts, req, settings, mode, currentHash, now);
  if (predicted) return deny(predicted);

  const results = await db.batch([
    ...sweep(db, owner, nowIso),
    db.prepare(`UPDATE submissions SET state = 'claimed', attempt_id = ?, claim_mode = ?, claimed_at = ?, relaxations = ?,
        resume_sha256 = ?, resume_filename = ?, fill_report_json = ?, page_url = ?, extension_version = ?, updated_at = ?
      WHERE id = ? AND owner_email = ? AND state = 'approved' AND expires_at > ?
        AND application_id = ? AND job_key = ? AND profile_hash = ?
        AND tailored_revision = (SELECT tailored_revision FROM applications WHERE id = ? AND owner_email = ? AND status IN ${OPEN_APP})
        AND NOT EXISTS (SELECT 1 FROM submissions x WHERE x.owner_email = ? AND x.job_key = ? AND x.state = 'submitted')
        AND NOT EXISTS (${resultForAttempt("?", "?")})
        AND (? = 'supervised' OR (
          (SELECT count(*) FROM submissions c WHERE c.owner_email = ? AND c.claim_mode = 'auto' AND c.claimed_at > ?) < ?
          AND NOT EXISTS (SELECT 1 FROM submissions c WHERE c.owner_email = ? AND c.claim_mode = 'auto' AND c.claimed_at > ?)))`)
      .bind(req.attemptId, mode, nowIso, req.relaxations.join(","), req.resumeSha256, req.resumeFilename,
        JSON.stringify(req.fillReport), req.pageUrl, req.extensionVersion, nowIso,
        req.approvalId, owner, nowIso, req.applicationId, req.jobKey, currentHash,
        req.applicationId, owner, owner, req.jobKey, owner, req.approvalId, req.attemptId,
        mode, owner, iso(now - DAY_MS), settings.dailyCap, owner, iso(now - AUTO_SPACING_MS)),
    db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, ?, ?, ?, 'extension', 'claimed', ?
      WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND owner_email = ? AND attempt_id = ? AND state = 'claimed')
        AND NOT EXISTS (SELECT 1 FROM submission_events e WHERE e.owner_email = ? AND e.submission_id = ? AND e.event = 'claimed'
          AND json_extract(e.detail_json, '$.attemptId') = ?)`)
      .bind(crypto.randomUUID(), owner, req.approvalId, nowIso,
        detailJson({ attemptId: req.attemptId, mode, relaxations: req.relaxations, resumeSha256: req.resumeSha256,
          resumeFilename: req.resumeFilename, fingerprint: req.fingerprint, pageUrl: req.pageUrl, extensionVersion: req.extensionVersion }),
        req.approvalId, owner, req.attemptId, owner, req.approvalId, req.attemptId),
    // Something changed between the read and the write (usually a second claim on the same approval).
    db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, ?, ?, ?, 'extension', 'claim_denied', ?
      WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE id = ? AND owner_email = ? AND attempt_id = ? AND state = 'claimed')`)
      .bind(crypto.randomUUID(), owner, req.approvalId, nowIso, JSON.stringify({ attemptId: req.attemptId, reason: "conflict" }),
        req.approvalId, owner, req.attemptId),
  ]);
  if (results[2]?.meta.changes === 1) return { ok: true, mode };
  // The same attempt sent twice can lose this race to itself: both read 'approved', and the other copy wrote first.
  const after = await claimFacts(db, owner, req, now);
  return sameAttempt(after, req) ?? denialFrom(after, req, settings, mode, currentHash, now) ?? { ok: false, reason: "already_claimed" };
}

const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => options.includes(value as T);
const OUTCOMES = ["submitted", "needs_you", "check", "not_clicked", "cancelled"] as const;
const CLICKERS = ["", "applypilot", "you"] as const;

function checkResult(value: unknown, now: number): SubmissionResult | null {
  if (!isObject(value)) return null;
  const outcome = value.outcome;
  const clickedBy = value.clickedBy ?? "";
  if (!oneOf(outcome, OUTCOMES) || !oneOf(clickedBy, CLICKERS) || typeof value.clicked !== "boolean") return null;
  const attemptId = value.attemptId === null || value.attemptId === undefined ? null : text(value.attemptId, 40);
  const pageUrl = text(value.pageUrl, 1000);
  const result: SubmissionResult = {
    resultId: text(value.resultId, 40), approvalId: text(value.approvalId, 40), attemptId,
    applicationId: text(value.applicationId, 80), jobKey: text(value.jobKey, 200), outcome, clicked: value.clicked, clickedBy,
    reasons: cleanReasons(value.reasons),
    pageUrl: pageUrl && parseAtsUrl(pageUrl) ? pageUrl : "",
    confirmationText: text(value.confirmationText, 300),
    startedAt: dateOr(value.startedAt, "", now), finishedAt: dateOr(value.finishedAt, iso(now), now),
    extensionVersion: text(value.extensionVersion, 20), confirmationKind: text(value.confirmationKind, 30),
    fingerprintMatched: typeof value.fingerprintMatched === "boolean" ? value.fingerprintMatched : null,
  };
  if (!UUID.test(result.resultId) || !UUID.test(result.approvalId) || (attemptId !== null && !UUID.test(attemptId))) return null;
  if (!result.applicationId || !result.jobKey) return null;
  // Anything clicked can never go back to "approved": that would allow a second submission.
  if (outcome === "not_clicked" && (result.clicked || clickedBy)) return null;
  return result;
}

function dateOr(value: unknown, fallback: string, now: number) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now + 5 * 60_000 ? iso(time) : fallback;
}

const cancelEventId = (approvalId: string, attemptId: string) => `${approvalId}:cancel:${attemptId}`;

// The guarded UPDATEs for one result; each matches only from the states the transition table allows.
function transition(db: SqlDatabase, owner: string, r: SubmissionResult, nowIso: string): SqlStatement[] {
  const target = "id = ? AND owner_email = ? AND application_id = ? AND job_key = ?";
  const keys = [r.approvalId, owner, r.applicationId, r.jobKey];
  const reasons = JSON.stringify(r.reasons);
  const firstReason = r.reasons.find((reason) => reason.text)?.text ?? "";
  if (r.outcome === "submitted") {
    // From this attempt's claim, its 'check', or a 'not_sent' you chose before the late result arrived; or your own
    // confirmed submission in a watched tab, whatever happened to the claim.
    const from = `((state IN ('claimed','check','not_sent') AND attempt_id = ?) OR
      (? = 'you' AND state IN ('claimed','needs_you','revoked','expired','check','not_sent')))`;
    // Calibration: your click on the form ApplyPilot checked, confirmed straight from the supervised claim. Only a
    // click the page saw match counts; one it couldn't compare (null) never does.
    const calibrated = r.clickedBy === "you" && r.fingerprintMatched === true && r.attemptId
      ? [db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
          SELECT ?, owner_email, id, ?, 'server', 'calibrated', ? FROM submissions
          WHERE ${target} AND state = 'claimed' AND attempt_id = ? AND claim_mode = 'supervised'`)
        .bind(`${r.resultId}:calibrated`, nowIso, JSON.stringify({ attemptId: r.attemptId }), ...keys, r.attemptId)]
      : [];
    return [
      ...calibrated,
      db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
        SELECT id || ':revoked', owner_email, id, ?, 'server', 'revoked', '{"reason":"Already submitted"}' FROM submissions
        WHERE owner_email = ? AND job_key = ? AND id != ? AND state = 'approved'
          AND EXISTS (SELECT 1 FROM submissions WHERE ${target} AND ${from})`)
        .bind(nowIso, owner, r.jobKey, r.approvalId, ...keys, r.attemptId, r.clickedBy),
      db.prepare(`UPDATE submissions SET state = 'revoked', reason = 'Already submitted', updated_at = ?
        WHERE owner_email = ? AND job_key = ? AND id != ? AND state = 'approved'
          AND EXISTS (SELECT 1 FROM submissions WHERE ${target} AND ${from})`)
        .bind(nowIso, owner, r.jobKey, r.approvalId, ...keys, r.attemptId, r.clickedBy),
      db.prepare(`UPDATE submissions SET state = 'submitted', clicked_by = ?, confirmation_text = ?, page_url = ?, finished_at = ?,
          reason = '', reasons_json = ?, extension_version = ?, updated_at = ?
        WHERE ${target} AND ${from}`)
        .bind(r.clickedBy, r.confirmationText, r.pageUrl, r.finishedAt, reasons, r.extensionVersion, nowIso, ...keys, r.attemptId, r.clickedBy),
      db.prepare(`UPDATE applications SET status = 'applied', updated_at = ? WHERE id = ? AND owner_email = ? AND status IN ${OPEN_APP}
          AND EXISTS (SELECT 1 FROM submissions WHERE ${target} AND state = 'submitted')`)
        .bind(nowIso, r.applicationId, owner, ...keys),
    ];
  }
  if (r.outcome === "needs_you") {
    if (r.clicked) return [];
    return [db.prepare(`UPDATE submissions SET state = 'needs_you', reason = ?, reasons_json = ?, page_url = ?, finished_at = ?,
        extension_version = ?, updated_at = ?
      WHERE ${target} AND (state = 'approved' OR (state = 'claimed' AND attempt_id = ?))`)
      .bind(firstReason || "ApplyPilot stopped and left this one for you.", reasons, r.pageUrl, r.finishedAt, r.extensionVersion, nowIso,
        ...keys, r.attemptId)];
  }
  if (r.outcome === "check") {
    const update = (from: string, ...fromArgs: unknown[]) =>
      db.prepare(`UPDATE submissions SET state = 'check', reason = ?, reasons_json = ?, clicked_by = ?, page_url = ?,
          confirmation_text = ?, finished_at = ?, extension_version = ?, updated_at = ?
        WHERE ${target} AND ${from}`)
        .bind(firstReason || "Submit pressed, no confirmation seen", reasons, r.clickedBy, r.pageUrl, r.confirmationText, r.finishedAt,
          r.extensionVersion, nowIso, ...keys, ...fromArgs);
    const fromClaim = update("state = 'claimed' AND attempt_id = ?", r.attemptId);
    if (r.clickedBy !== "you") return [fromClaim];
    // You pressed Submit yourself: in a needs-you tab, before ApplyPilot claimed it, or again after you said it didn't
    // go through. That may have sent it, so the job waits for your answer instead of being offered for approval
    // again, and a newer approval of it is withdrawn.
    const yours = "state IN ('approved','needs_you','not_sent')";
    const others = `owner_email = ? AND job_key = ? AND id != ? AND state = 'approved'
      AND EXISTS (SELECT 1 FROM submissions WHERE ${target} AND ${yours})`;
    const othersArgs = [owner, r.jobKey, r.approvalId, ...keys];
    return [
      fromClaim,
      db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
        SELECT id || ':revoked', owner_email, id, ?, 'server', 'revoked', '{"reason":"You clicked Submit in the open tab"}'
        FROM submissions WHERE ${others}`).bind(nowIso, ...othersArgs),
      db.prepare(`UPDATE submissions SET state = 'revoked', reason = 'You clicked Submit in the open tab', updated_at = ? WHERE ${others}`)
        .bind(nowIso, ...othersArgs),
      update(`${yours} AND NOT EXISTS (SELECT 1 FROM submissions x WHERE x.owner_email = ? AND x.job_key = ? AND x.id != ?
        AND x.state IN ('approved','claimed','check'))`, owner, r.jobKey, r.approvalId),
    ];
  }
  if (r.outcome === "not_clicked") {
    // "Stop everything" while this claim was out: the claim comes back cancelled, never approved again.
    const cancelAsked = `EXISTS (SELECT 1 FROM submission_events c WHERE c.owner_email = ? AND c.id = ?)`;
    const cancelId = cancelEventId(r.approvalId, r.attemptId ?? "");
    return [
      db.prepare(`UPDATE submissions SET state = CASE WHEN ${cancelAsked} THEN 'revoked' WHEN expires_at > ? THEN 'approved' ELSE 'expired' END,
          reason = CASE WHEN ${cancelAsked} THEN 'Cancelled by you' WHEN expires_at > ? THEN '' ELSE 'Approval expired' END, updated_at = ?
        WHERE ${target} AND state = 'claimed' AND attempt_id = ?`)
        .bind(owner, cancelId, nowIso, owner, cancelId, nowIso, nowIso, ...keys, r.attemptId),
      db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
        SELECT id || ':expired', owner_email, id, ?, 'server', 'expired', '{}' FROM submissions WHERE ${target} AND state = 'expired'`)
        .bind(nowIso, ...keys),
      db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
        SELECT id || ':revoked', owner_email, id, ?, 'peter', 'revoked', '{"reason":"Cancelled by you"}' FROM submissions
        WHERE ${target} AND state = 'revoked' AND ${cancelAsked}`)
        .bind(nowIso, ...keys, owner, cancelId),
    ];
  }
  return []; // cancelled: recorded as an event only
}

export async function recordResults(db: SqlDatabase, owner: string, input: unknown, now = Date.now()) {
  if (!Array.isArray(input) || input.length > MAX_RESULTS) throw new UserFacingError(`Send at most ${MAX_RESULTS} results at a time.`, 400);
  const nowIso = iso(now);
  const valid: SubmissionResult[] = [];
  const rejected: { resultId: string; reason: string }[] = [];
  for (const raw of input) {
    const result = checkResult(raw, now);
    if (result && !valid.some((other) => other.resultId === result.resultId)) valid.push(result);
    else if (!result) rejected.push({ resultId: isObject(raw) ? text(raw.resultId, 40) : "", reason: "invalid_result" });
  }
  if (!valid.length) return { acked: [] as string[], rejected, notYours: [] as string[], submissions: [] as SubmissionRow[] };
  // A result for an approval this account doesn't own is left in Chrome for the account that does.
  const asked = [...new Set(valid.map((r) => r.approvalId))];
  const owned = new Set((await db.prepare(`SELECT id FROM submissions WHERE owner_email = ? AND id IN (${marks(asked.length)})`)
    .bind(owner, ...asked).all<{ id: string }>()).results.map((row) => row.id));
  const mine = valid.filter((r) => owned.has(r.approvalId));
  const notYours = valid.filter((r) => !owned.has(r.approvalId)).map((r) => r.resultId);
  if (!mine.length) return { acked: [] as string[], rejected, notYours, submissions: [] as SubmissionRow[] };
  const ids = mine.map((r) => r.resultId);
  const seen = new Set((await db.prepare(`SELECT id FROM submission_events WHERE owner_email = ? AND id IN (${marks(ids.length)})`)
    .bind(owner, ...ids).all<{ id: string }>()).results.map((row) => row.id));
  // A result already recorded is acked again but applied once. The event and its transition commit together.
  const statements: SqlStatement[] = [];
  for (const r of mine) {
    if (seen.has(r.resultId)) continue;
    statements.push(db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, ?, ?, ?, 'extension', ?, ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND owner_email = ?)`)
      .bind(r.resultId, owner, r.approvalId, nowIso, `result:${r.outcome}`,
        detailJson({ attemptId: r.attemptId, applicationId: r.applicationId, jobKey: r.jobKey, clicked: r.clicked, clickedBy: r.clickedBy,
          reasons: r.reasons, pageUrl: r.pageUrl, confirmationText: r.confirmationText, confirmationKind: r.confirmationKind,
          startedAt: r.startedAt, finishedAt: r.finishedAt, extensionVersion: r.extensionVersion, fingerprintMatched: r.fingerprintMatched }),
        r.approvalId, owner));
    statements.push(...transition(db, owner, r, nowIso));
  }
  if (statements.length) await db.batch(statements);
  const approvalIds = [...new Set(mine.map((r) => r.approvalId))];
  const rows = (await db.prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE owner_email = ? AND id IN (${marks(approvalIds.length)})`)
    .bind(owner, ...approvalIds).all<DbRow>()).results.map(toRow);
  return { acked: ids, rejected, notYours, submissions: rows };
}

export async function cancelSubmissions(db: SqlDatabase, owner: string, ids: readonly unknown[] | "all", now = Date.now()) {
  const nowIso = iso(now);
  type Found = { id: string; state: string; attempt_id: string | null };
  let found: Found[];
  if (ids === "all") {
    found = (await db.prepare("SELECT id, state, attempt_id FROM submissions WHERE owner_email = ? AND state IN ('approved','claimed')")
      .bind(owner).all<Found>()).results;
  } else {
    // D1 allows 100 bound values per statement.
    const list = [...new Set(ids.filter((id): id is string => typeof id === "string" && UUID.test(id)))].slice(0, 50);
    if (!list.length) return { revoked: [] as string[], tooLate: [] as string[] };
    found = (await db.prepare(`SELECT id, state, attempt_id FROM submissions WHERE owner_email = ? AND state IN ('approved','claimed')
      AND id IN (${marks(list.length)})`).bind(owner, ...list).all<Found>()).results;
  }
  const claimed = found.filter((row) => row.state === "claimed");
  const pending = found.filter((row) => row.state === "approved").map((row) => row.id);
  // A claim can't be taken back under the runner, but if the runner gives it back, it comes back cancelled.
  const cancelAsks = claimed.filter((row) => row.attempt_id).map((row) =>
    db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, owner_email, id, ?, 'peter', 'cancel_requested', ? FROM submissions WHERE id = ? AND owner_email = ? AND state = 'claimed' AND attempt_id = ?`)
      .bind(cancelEventId(row.id, String(row.attempt_id)), nowIso, JSON.stringify({ attemptId: row.attempt_id }), row.id, owner, row.attempt_id));
  // Every row read, whatever happened to it since: a pending row claimed in the meantime gets the same cancel
  // marker, and a claim given back in the meantime (approved again) is revoked like the others. The markers go last
  // so the revoke results keep their places.
  const asked = [...pending, ...claimed.map((row) => row.id)];
  const revokes = asked.flatMap((id) => revoke(db, owner, id, "Cancelled by you", "peter", nowIso));
  const lateAsks = asked.map((id) =>
    db.prepare(`INSERT OR IGNORE INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT id || ':cancel:' || attempt_id, owner_email, id, ?, 'peter', 'cancel_requested', json_object('attemptId', attempt_id)
      FROM submissions WHERE id = ? AND owner_email = ? AND state = 'claimed' AND attempt_id IS NOT NULL`)
      .bind(nowIso, id, owner));
  if (!asked.length) return { revoked: [] as string[], tooLate: [] as string[] };
  const results = await db.batch([...cancelAsks, ...revokes, ...lateAsks]);
  const revoked = asked.filter((_, index) => results[cancelAsks.length + index * 2 + 1]?.meta.changes === 1);
  // A row that moved on between the read and the write was claimed (or expired) in the meantime.
  const tooLate = asked.filter((id) => !revoked.includes(id));
  return { revoked, tooLate };
}

export async function resolveSubmission(db: SqlDatabase, owner: string, id: unknown, outcome: unknown, now = Date.now()) {
  if (typeof id !== "string" || !UUID.test(id) || (outcome !== "submitted" && outcome !== "not_sent")) throw invalid();
  const nowIso = iso(now);
  const results = await db.batch([
    db.prepare(`UPDATE submissions SET state = ?, reason = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ? AND owner_email = ? AND (state = 'check' OR
        (state = 'claimed' AND claimed_at < CASE WHEN claim_mode = 'supervised' THEN ? ELSE ? END))`)
      .bind(outcome, outcome === "submitted" ? "You said it went through" : "You said it didn't go through", nowIso, nowIso,
        id, owner, iso(now - STALE_SUPERVISED_CLAIM_MS), iso(now - STALE_CLAIM_MS)),
    db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      SELECT ?, ?, ?, ?, 'peter', ?, '{}' WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND owner_email = ? AND state = ? AND updated_at = ?)`)
      .bind(crypto.randomUUID(), owner, id, nowIso, `resolved:${outcome}`, id, owner, outcome, nowIso),
    db.prepare(`UPDATE applications SET status = 'applied', updated_at = ? WHERE owner_email = ? AND status IN ${OPEN_APP}
      AND id = (SELECT application_id FROM submissions WHERE id = ? AND owner_email = ? AND state = 'submitted' AND updated_at = ?)`)
      .bind(nowIso, owner, id, owner, nowIso),
  ]);
  if (results[0]?.meta.changes !== 1) throw new UserFacingError("This one can't be changed now. Reload to see where it stands.", 409);
  const row = await db.prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE id = ? AND owner_email = ?`).bind(id, owner).first<DbRow>();
  return row ? toRow(row) : null;
}

async function readRows(db: SqlDatabase, owner: string, now: number, id?: string) {
  if (id) {
    return (await db.prepare(`SELECT ${ROW_COLUMNS}, fill_report_json FROM submissions WHERE owner_email = ? AND id = ?`)
      .bind(owner, id).all<DbRow>()).results.map(toRow);
  }
  return (await db.prepare(`SELECT ${ROW_COLUMNS} FROM submissions WHERE owner_email = ? AND (state IN ${LIVE} OR updated_at > ?)
    ORDER BY state IN ${LIVE} DESC, updated_at DESC LIMIT ${LIST_LIMIT}`).bind(owner, iso(now - LIST_WINDOW_MS)).all<DbRow>()).results.map(toRow);
}

// Targets for every open application, the settings and the calibration counts in one read.
async function panel(db: SqlDatabase, owner: string) {
  const rows = (await db.prepare(`WITH ${CALIBRATION}
    SELECT cal.*, p.owner_email AS profile_owner, p.apply_settings_json AS settings_json,
      a.id AS app_id, a.url AS app_url, f.kind AS found_kind, f.external_id AS found_external_id, j.token AS source_token
    FROM (SELECT ? AS owner) o CROSS JOIN cal
    LEFT JOIN profiles p ON p.owner_email = o.owner
    LEFT JOIN applications a ON a.owner_email = o.owner AND a.status IN ${OPEN_APP}
    LEFT JOIN found_jobs f ON f.application_id = a.id AND f.owner_email = o.owner
    LEFT JOIN job_sources j ON j.id = f.source_id AND j.owner_email = o.owner`).bind(owner, owner).all<DbRow>()).results;
  const targets: Record<string, ApplyTarget | { reason: string }> = {};
  for (const [id, job] of byApplication(rows)) targets[id] = targetOf(job);
  return {
    targets,
    settings: parseSettings(rows[0]?.settings_json),
    calibration: calibrationOf(rows[0]),
    hasProfile: Boolean(rows[0]?.profile_owner),
  };
}

export async function listSubmissions(db: SqlDatabase, owner: string, now = Date.now(), opts: { id?: string } = {}) {
  await db.batch(sweep(db, owner, iso(now)));
  const submissions = await readRows(db, owner, now, opts.id);
  const cal = await db.prepare(`WITH ${CALIBRATION} SELECT * FROM cal`).bind(owner).first<DbRow>();
  return { submissions, calibration: calibrationOf(cal) };
}

// Everything GET /api/submissions returns, in three reads.
export async function submissionsPage(db: SqlDatabase, owner: string, now = Date.now()) {
  await db.batch(sweep(db, owner, iso(now)));
  const submissions = await readRows(db, owner, now);
  const { targets, settings, calibration } = await panel(db, owner);
  return { submissions, targets, settings, calibration };
}

export async function targetsFor(db: SqlDatabase, owner: string) {
  return (await panel(db, owner)).targets;
}

export async function loadSettings(db: SqlDatabase, owner: string): Promise<SubmitSettings> {
  const row = await db.prepare("SELECT apply_settings_json FROM profiles WHERE owner_email = ?").bind(owner).first<DbRow>();
  return parseSettings(row?.apply_settings_json);
}

export async function saveSettings(db: SqlDatabase, owner: string, input: unknown, now = Date.now()): Promise<SubmitSettings> {
  const next = checkSettings(input);
  const row = await db.prepare(`WITH ${CALIBRATION}
    SELECT cal.*, p.owner_email AS profile_owner, p.apply_settings_json AS settings_json
    FROM (SELECT ? AS owner) o CROSS JOIN cal LEFT JOIN profiles p ON p.owner_email = o.owner`).bind(owner, owner).first<DbRow>();
  if (!row?.profile_owner) throw new UserFacingError("Your profile isn't set up yet. Reload and try again.", 404);
  const before = parseSettings(row.settings_json);
  // A dashboard tab opened before this setting existed saves without it; that keeps your choice, not the default.
  if (isObject(input) && input.allowPrivacyAck === undefined) next.allowPrivacyAck = before.allowPrivacyAck;
  const calibration = calibrationOf(row);
  for (const ats of ATS_LIST) {
    if (next.auto[ats] && calibration[ats] < CALIBRATION_NEEDED) {
      throw new UserFacingError(
        `ApplyPilot can click Submit on ${ATS_NAMES[ats]} after ${CALIBRATION_NEEDED} of your own submissions there are confirmed (${calibration[ats]} so far).`,
        400,
      );
    }
  }
  const nowIso = iso(now);
  await db.batch([
    db.prepare("UPDATE profiles SET apply_settings_json = ? WHERE owner_email = ?").bind(JSON.stringify(next), owner),
    db.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      VALUES (?, ?, '', ?, 'peter', 'settings', ?)`)
      .bind(crypto.randomUUID(), owner, nowIso, detailJson({ before, after: next })),
  ]);
  return next;
}
