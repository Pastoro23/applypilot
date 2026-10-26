import { parseJobUrl } from "./job-posting.ts";

// Where ApplyPilot may open a job's hosted application form. Pure: used by the server, the dashboard and,
// as a copy in extension/ats.js, the extension. tests/fixtures/ats-urls.json keeps the copies in step.

export type Ats = "greenhouse" | "lever" | "ashby";
export type ParsedAtsUrl = { ats: Ats; board: string; jobId: string; jobKey: string };
export type ApplyTarget = ParsedAtsUrl & { applyUrls: string[] };

const HOSTS = new Map<string, Ats>([
  ["job-boards.greenhouse.io", "greenhouse"],
  ["boards.greenhouse.io", "greenhouse"],
  ["jobs.lever.co", "lever"],
  ["jobs.eu.lever.co", "lever"],
  ["jobs.ashbyhq.com", "ashby"],
]);
export const ALLOWED_HOSTS = [...HOSTS.keys()];

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/i; // same rule as job-discovery board tokens
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
const ATS_DOMAIN = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/;

const NO_LINK = "No job link: apply yourself";
const COMPANY_SITE = "Company site, not Greenhouse, Lever or Ashby: apply yourself";
const NOT_HTTPS = "The job link isn't https: apply yourself";
const NOT_A_JOB = "This link isn't a single Greenhouse, Lever or Ashby job: apply yourself";

export function jobKeyOf(ats: Ats, board: string, jobId: string) {
  return `${ats}:${board.toLowerCase()}:${jobId}`;
}

export function isAts(value: unknown): value is Ats {
  return value === "greenhouse" || value === "lever" || value === "ashby";
}

export function parseAtsUrl(raw: string): ParsedAtsUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const ats = HOSTS.get(url.hostname);
  if (!ats) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let board = "";
  let jobId = "";
  if (ats === "greenhouse") {
    if (parts[0] === "embed") {
      if (parts[1] === "job_app" && parts.length === 2) {
        board = url.searchParams.get("for") ?? "";
        jobId = url.searchParams.get("token") ?? "";
      }
    } else if (parts[1] === "jobs") {
      board = parts[0];
      jobId = parts[2] ?? "";
    }
  } else {
    board = parts[0] ?? "";
    jobId = parts[1] ?? "";
  }
  if (!TOKEN.test(board) || !JOB_ID.test(jobId)) return null;
  return { ats, board, jobId, jobKey: jobKeyOf(ats, board, jobId) };
}

// Hosted form candidates, best first. Never the company's own careers page.
export function applyUrlsFor(ats: Ats, board: string, jobId: string, eu = false) {
  const b = encodeURIComponent(board);
  const id = encodeURIComponent(jobId);
  if (ats === "greenhouse") {
    // [UNVERIFIED] that the embed page serves the form top-level.
    return [`https://job-boards.greenhouse.io/${b}/jobs/${id}`, `https://job-boards.greenhouse.io/embed/job_app?for=${b}&token=${id}`];
  }
  if (ats === "lever") return [`https://${eu ? "jobs.eu.lever.co" : "jobs.lever.co"}/${b}/${id}/apply`];
  return [`https://jobs.ashbyhq.com/${b}/${id}/application`];
}

function hostOf(raw: string) {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

function build(ats: Ats, board: string, jobId: string, eu: boolean): ApplyTarget | { reason: string } {
  if (!TOKEN.test(board) || !JOB_ID.test(jobId)) return { reason: NOT_A_JOB };
  const jobKey = jobKeyOf(ats, board, jobId);
  const applyUrls = applyUrlsFor(ats, board, jobId, eu);
  // The extension re-checks every candidate this way, so a URL that doesn't round-trip is refused here too.
  if (!applyUrls.every((url) => parseAtsUrl(url)?.jobKey === jobKey)) return { reason: NOT_A_JOB };
  return { ats, board, jobId, jobKey, applyUrls };
}

export function applyTarget(input: {
  url: string; kind?: string | null; token?: string | null; externalId?: string | null;
}): ApplyTarget | { reason: string } {
  const url = (input.url ?? "").trim();
  // A found job knows its board and id, so the form is rebuilt from them instead of trusting the listed link.
  if (isAts(input.kind) && input.token && input.externalId) {
    return build(input.kind, input.token, input.externalId, input.kind === "lever" && hostOf(url) === "jobs.eu.lever.co");
  }
  if (!url) return { reason: NO_LINK };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: NO_LINK };
  }
  const job = parseJobUrl(url);
  if (job.kind === "page") return { reason: ATS_DOMAIN.test(parsed.hostname) ? NOT_A_JOB : COMPANY_SITE };
  if (parsed.protocol !== "https:") return { reason: NOT_HTTPS };
  if (!HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) return { reason: NOT_A_JOB };
  if (job.kind === "greenhouse") return build("greenhouse", job.board, job.id, false);
  if (job.kind === "lever") return build("lever", job.company, job.id, job.eu);
  return build("ashby", job.org, job.id, false);
}

export function isApplyTarget(value: ApplyTarget | { reason: string } | undefined): value is ApplyTarget {
  return Boolean(value && "jobKey" in value);
}
