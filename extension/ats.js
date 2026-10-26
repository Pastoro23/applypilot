// A plain-JS copy of parseAtsUrl and ALLOWED_HOSTS from app/apply-target.ts.
// tests/fixtures/ats-urls.json keeps the two copies in agreement.

const HOSTS = new Map([
  ["job-boards.greenhouse.io", "greenhouse"],
  ["boards.greenhouse.io", "greenhouse"],
  ["jobs.lever.co", "lever"],
  ["jobs.eu.lever.co", "lever"],
  ["jobs.ashbyhq.com", "ashby"],
]);
export const ALLOWED_HOSTS = [...HOSTS.keys()];
export const HOST_PATTERNS = ALLOWED_HOSTS.map((h) => `https://${h}/*`);

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;

export function jobKeyOf(ats, board, jobId) {
  return `${ats}:${board.toLowerCase()}:${jobId}`;
}

export function isAts(value) {
  return value === "greenhouse" || value === "lever" || value === "ashby";
}

export function parseAtsUrl(raw) {
  let url;
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

// https on one of the five ATS hosts, nothing else.
export function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
