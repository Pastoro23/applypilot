import { checkedJobUrl, fetchJobText, JobReadError } from "./job-fetch.ts";
export { JobReadError } from "./job-fetch.ts";

// Reads a job posting from its link. Greenhouse, Lever and Ashby expose public
// job-board APIs; any other page falls back to its JobPosting structured data
// or, failing that, its visible text.

export type JobPosting = {
  company: string;
  role: string;
  location: string;
  description: string;
  source: "greenhouse" | "lever" | "ashby" | "structured-data" | "page-text";
};

const MAX_DESCRIPTION = 20000;


export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|section|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/\n{2,}- /g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(text: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", bull: "•", hellip: "…" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

export function titleCase(slug: string) {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function getJson(url: string) {
  const body = await fetchJobText(url, "json");
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { throw new JobReadError("The job board returned unreadable data. Paste the description instead."); }
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function parseJobUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const ghJobId = url.searchParams.get("gh_jid");

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // boards.greenhouse.io/{board}/jobs/{id} or job-boards.greenhouse.io/{board}/jobs/{id}
    const jobsAt = parts.indexOf("jobs");
    const board = url.searchParams.get("for") || (jobsAt > 0 ? parts[jobsAt - 1] : parts[0]);
    const id = ghJobId || (jobsAt >= 0 ? parts[jobsAt + 1] : "") || url.searchParams.get("token");
    if (board && id) return { kind: "greenhouse" as const, board, id };
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts.length >= 2) return { kind: "lever" as const, company: parts[0], id: parts[1], eu: host.includes(".eu.") };
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts.length >= 2) return { kind: "ashby" as const, org: parts[0], id: parts[1] };
  }
  return { kind: "page" as const };
}

export async function readJobPosting(raw: string): Promise<JobPosting> {
  checkedJobUrl(raw);
  const target = parseJobUrl(raw);

  if (target.kind === "greenhouse") {
    const job = await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.board)}/jobs/${encodeURIComponent(target.id)}`,
    );
    const location = job.location as { name?: string } | undefined;
    return {
      company: str(job.company_name) || titleCase(target.board),
      role: str(job.title),
      location: location?.name ?? "",
      // Greenhouse returns the description as entity-escaped HTML.
      description: htmlToText(decodeEntities(str(job.content))).slice(0, MAX_DESCRIPTION),
      source: "greenhouse",
    };
  }

  if (target.kind === "lever") {
    const host = target.eu ? "api.eu.lever.co" : "api.lever.co";
    const job = await getJson(
      `https://${host}/v0/postings/${encodeURIComponent(target.company)}/${encodeURIComponent(target.id)}`,
    );
    const categories = (job.categories ?? {}) as { location?: string };
    const lists = Array.isArray(job.lists) ? (job.lists as { text?: string; content?: string }[]) : [];
    const description = [
      str(job.descriptionPlain) || htmlToText(str(job.description)),
      ...lists.map((list) => `${list.text ?? ""}\n${htmlToText(list.content ?? "")}`),
      str(job.additionalPlain) || htmlToText(str(job.additional)),
    ]
      .filter((part) => part.trim())
      .join("\n\n");
    return {
      company: titleCase(target.company),
      role: str(job.text),
      location: categories.location ?? "",
      description: description.slice(0, MAX_DESCRIPTION),
      source: "lever",
    };
  }

  if (target.kind === "ashby") {
    const board = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.org)}`);
    const jobs = Array.isArray(board.jobs) ? (board.jobs as Record<string, unknown>[]) : [];
    const job = jobs.find((item) => item.id === target.id || str(item.jobUrl).includes(target.id));
    if (!job) throw new JobReadError("That job is no longer posted.");
    return {
      company: titleCase(target.org),
      role: str(job.title),
      location: str(job.location),
      description: (str(job.descriptionPlain) || htmlToText(str(job.descriptionHtml))).slice(0, MAX_DESCRIPTION),
      source: "ashby",
    };
  }

  const html = await fetchJobText(raw, "html");
  return fromStructuredData(html) ?? fromPageText(html);
}

function fromStructuredData(html: string): JobPosting | null {
  const blocks = html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const item = queue.shift();
      if (Array.isArray(item)) {
        queue.push(...item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (Array.isArray(record["@graph"])) queue.push(...(record["@graph"] as unknown[]));
      const type = record["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
        const org = record.hiringOrganization as { name?: string } | undefined;
        const place = (Array.isArray(record.jobLocation) ? record.jobLocation[0] : record.jobLocation) as
          | { address?: { addressLocality?: string; addressRegion?: string } }
          | undefined;
        const location = [place?.address?.addressLocality, place?.address?.addressRegion].filter(Boolean).join(", ");
        return {
          company: org?.name ?? "",
          role: decodeEntities(str(record.title)),
          location: record.jobLocationType === "TELECOMMUTE" ? location || "Remote" : location,
          description: htmlToText(decodeEntities(str(record.description))).slice(0, MAX_DESCRIPTION),
          source: "structured-data",
        };
      }
    }
  }
  return null;
}

function fromPageText(html: string): JobPosting {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  const description = htmlToText(main);
  if (description.length < 200) {
    throw new JobReadError("This page loads its job details with scripts, so ApplyPilot can't read it. Paste the description instead.");
  }
  return { company: "", role: title, location: "", description: description.slice(0, MAX_DESCRIPTION), source: "page-text" };
}
