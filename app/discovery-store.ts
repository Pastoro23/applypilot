import type { SqlDatabase, SqlStatement } from "./ai-operations.ts";
import { UserFacingError } from "./errors.ts";
import { fetchBoardJobs, scoreJob, type Board, type BoardJob, type BoardKind, type JobSearch } from "./job-discovery.ts";

export const MAX_SOURCES = 100;
const MAX_MATCHES_PER_SOURCE = 100;
const RECHECK_AFTER_MS = 60_000;
export const BOARDS_PER_CALL = 12;

export type SourceRow = { id: string; kind: BoardKind; token: string; label: string; last_checked_at: string | null };
type FoundRow = { id: string; external_id: string; status: string; application_id: string | null };
export type FoundJobRow = {
  id: string; company: string; title: string; location: string; url: string; description: string;
  status: string; application_id: string | null;
};

export const defaultSearch: JobSearch = { titleWords: "", locations: "", excludeWords: "", remoteOk: "yes" };

export async function loadSearch(db: SqlDatabase, owner: string): Promise<JobSearch> {
  const row = await db.prepare(`SELECT title_words AS titleWords, locations, exclude_words AS excludeWords,
    remote_ok AS remoteOk FROM job_searches WHERE owner_email = ?`).bind(owner).first<JobSearch>();
  return row ?? defaultSearch;
}

// Re-reads one board and brings its "new" matches up to date. Jobs already added or dismissed are left alone.
export async function refreshSource(
  db: SqlDatabase, owner: string, source: SourceRow, search: JobSearch,
  read: (board: Board, label: string) => Promise<BoardJob[]> = fetchBoardJobs, now = Date.now(),
) {
  const checkedAt = new Date(now).toISOString();
  let jobs: BoardJob[];
  try {
    jobs = await read({ kind: source.kind, token: source.token }, source.label);
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    const message = /no longer posted|answered 404/.test(text)
      ? "No job board found at this link. Check it."
      : "This job board couldn't be read. ApplyPilot will try again next time.";
    await db.prepare("UPDATE job_sources SET last_checked_at = ?, last_error = ? WHERE id = ? AND owner_email = ?")
      .bind(checkedAt, message, source.id, owner).run();
    return { matched: 0, added: 0, error: message };
  }
  const matches = jobs
    .map((job) => ({ job, score: scoreJob(job, search, now) }))
    .filter((match): match is { job: BoardJob; score: number } => match.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES_PER_SOURCE);
  const existing = (await db.prepare("SELECT id, external_id, status, application_id FROM found_jobs WHERE owner_email = ? AND source_id = ?")
    .bind(owner, source.id).all<FoundRow>()).results;
  const byExternal = new Map(existing.map((row) => [row.external_id, row]));
  const keep = new Set(matches.map((match) => match.job.externalId));
  const statements: SqlStatement[] = [];
  let added = 0;
  for (const { job, score } of matches) {
    const row = byExternal.get(job.externalId);
    if (row?.status === "new") {
      statements.push(db.prepare(`UPDATE found_jobs SET company = ?, title = ?, location = ?, url = ?, posted_at = ?,
        description = ?, score = ? WHERE id = ? AND owner_email = ? AND status = 'new'`)
        .bind(job.company, job.title, job.location, job.url, job.postedAt, job.description, score, row.id, owner));
    } else if (!row) {
      added++;
      statements.push(db.prepare(`INSERT OR IGNORE INTO found_jobs (id, owner_email, source_id, kind, external_id, company,
        title, location, url, posted_at, description, score, status, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`)
        .bind(crypto.randomUUID(), owner, source.id, source.kind, job.externalId, job.company, job.title, job.location,
          job.url, job.postedAt, job.description, score, checkedAt));
    }
  }
  // Closed postings and jobs that no longer fit the search drop off the list.
  for (const row of existing) {
    if (row.status === "new" && !keep.has(row.external_id)) {
      statements.push(db.prepare("DELETE FROM found_jobs WHERE id = ? AND owner_email = ? AND status = 'new'").bind(row.id, owner));
    }
  }
  statements.push(db.prepare("UPDATE job_sources SET last_checked_at = ?, last_error = '' WHERE id = ? AND owner_email = ?")
    .bind(checkedAt, source.id, owner));
  await db.batch(statements);
  return { matched: matches.length, added, error: "" };
}

export async function refreshAll(
  db: SqlDatabase, owner: string,
  read: (board: Board, label: string) => Promise<BoardJob[]> = fetchBoardJobs, now = Date.now(),
) {
  const search = await loadSearch(db, owner);
  const due = (await db.prepare(`SELECT id, kind, token, label, last_checked_at FROM job_sources WHERE owner_email = ?
    ORDER BY last_checked_at IS NOT NULL, last_checked_at, created_at`).bind(owner).all<SourceRow>()).results
    .filter((source) => !source.last_checked_at || now - new Date(source.last_checked_at).getTime() > RECHECK_AFTER_MS);
  // Workers cap outbound requests per call, so a call checks a slice; the page calls again while boards remain.
  const sources = due.slice(0, BOARDS_PER_CALL);
  let matched = 0, added = 0, failed = 0;
  for (let i = 0; i < sources.length; i += 4) {
    const results = await Promise.all(sources.slice(i, i + 4).map((source) => refreshSource(db, owner, source, search, read, now)));
    for (const result of results) {
      matched += result.matched;
      added += result.added;
      if (result.error) failed++;
    }
  }
  return { checked: sources.length, remaining: due.length - sources.length, matched, added, failed };
}

// Moves a found job into Applications. The found job is claimed first, so a double click can't create two applications.
export async function queueFoundJob(
  db: SqlDatabase, owner: string, id: string,
  readDescription: (url: string) => Promise<string>,
) {
  const job = await db.prepare(`SELECT id, company, title, location, url, description, status, application_id
    FROM found_jobs WHERE id = ? AND owner_email = ?`).bind(id, owner).first<FoundJobRow>();
  if (!job) throw new UserFacingError("That job is no longer in your list.", 404);
  if (job.status === "queued" && job.application_id) return { applicationId: job.application_id, descriptionMissing: false };
  const applicationId = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE found_jobs SET status = 'queued', application_id = ?
    WHERE id = ? AND owner_email = ? AND status != 'queued'`).bind(applicationId, id, owner).run();
  if (claim.meta.changes !== 1) {
    const current = await db.prepare("SELECT application_id FROM found_jobs WHERE id = ? AND owner_email = ?")
      .bind(id, owner).first<{ application_id: string | null }>();
    if (current?.application_id) return { applicationId: current.application_id, descriptionMissing: false };
    throw new UserFacingError("That job is being added already.", 409);
  }
  let description = job.description;
  if (!description) {
    try {
      description = await readDescription(job.url);
    } catch {
      description = "";
    }
  }
  try {
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO applications (id, owner_email, company, role, location, url, status, notes, job_description,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'saved', ?, ?, ?, ?)`)
      .bind(applicationId, owner, job.company, job.title, job.location, job.url, "Found by ApplyPilot job search.",
        description.slice(0, 20000), now, now).run();
  } catch (error) {
    await db.prepare("UPDATE found_jobs SET status = ?, application_id = NULL WHERE id = ? AND owner_email = ?")
      .bind(job.status, id, owner).run();
    throw error;
  }
  return { applicationId, descriptionMissing: description.trim().length < 100 };
}

export async function setFoundJobStatus(db: SqlDatabase, owner: string, id: string, status: "new" | "dismissed") {
  const result = await db.prepare(`UPDATE found_jobs SET status = ? WHERE id = ? AND owner_email = ? AND status != 'queued'`)
    .bind(status, id, owner).run();
  if (result.meta.changes !== 1) throw new UserFacingError("That job can't be changed.", 404);
}
