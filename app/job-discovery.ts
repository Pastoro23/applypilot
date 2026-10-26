import { fetchJobText, JobReadError } from "./job-fetch.ts";
import { htmlToText, titleCase } from "./job-posting.ts";

// Finds open jobs on the public Greenhouse, Lever and Ashby boards of companies the user follows.

export type BoardKind = "greenhouse" | "lever" | "ashby";
export type Board = { kind: BoardKind; token: string };
export type BoardJob = {
  externalId: string;
  company: string;
  title: string;
  location: string;
  url: string;
  postedAt: string;
  description: string;
};
export type JobSearch = { titleWords: string; locations: string; excludeWords: string; remoteOk: string };

const MAX_BOARD_BYTES = 6 * 1024 * 1024;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

// Accepts a board or job link (boards.greenhouse.io/acme, jobs.lever.co/acme/123, jobs.ashbyhq.com/acme)
// or a short form such as "greenhouse:acme".
export function parseBoard(raw: string): Board | null {
  const text = raw.trim();
  const short = text.match(/^(greenhouse|lever|ashby)\s*:\s*(\S+)$/i);
  if (short) {
    const token = short[2];
    return TOKEN.test(token) ? { kind: short[1].toLowerCase() as BoardKind, token } : null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let board: Board | null = null;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const token = url.searchParams.get("for") || (parts[0] === "embed" ? "" : parts[0]);
    if (token) board = { kind: "greenhouse", token };
  } else if (host === "jobs.lever.co" && parts[0]) board = { kind: "lever", token: parts[0] };
  else if (host === "jobs.ashbyhq.com" && parts[0]) board = { kind: "ashby", token: parts[0] };
  return board && TOKEN.test(board.token) ? board : null;
}

export function boardUrl(board: Board) {
  const token = encodeURIComponent(board.token);
  if (board.kind === "greenhouse") return `https://job-boards.greenhouse.io/${token}`;
  if (board.kind === "lever") return `https://jobs.lever.co/${token}`;
  return `https://jobs.ashbyhq.com/${token}`;
}

async function getJson(url: string) {
  const body = await fetchJobText(url, "json", 15_000, MAX_BOARD_BYTES);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new JobReadError("The job board returned unreadable data.");
  }
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const records = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
const isoDate = (value: unknown) => {
  const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const httpsUrl = (value: unknown) => {
  try {
    const url = new URL(str(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

// Lever lists carry full descriptions, so a big board is read in pages to stay under the size limit.
const LEVER_PAGE = 100;
const LEVER_MAX_PAGES = 4;
async function leverPostings(token: string) {
  const all: Record<string, unknown>[] = [];
  for (let page = 0; page < LEVER_MAX_PAGES; page++) {
    const batch = records(await getJson(`https://api.lever.co/v0/postings/${token}?mode=json&limit=${LEVER_PAGE}&skip=${page * LEVER_PAGE}`));
    all.push(...batch);
    if (batch.length < LEVER_PAGE) break;
  }
  return all;
}

export async function fetchBoardJobs(board: Board, label = ""): Promise<BoardJob[]> {
  const token = encodeURIComponent(board.token);
  const company = label || titleCase(board.token);
  let jobs: BoardJob[];
  if (board.kind === "greenhouse") {
    const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`)) as { jobs?: unknown };
    jobs = records(data?.jobs).map((job) => ({
      externalId: String(job.id ?? ""),
      company: str(job.company_name) || company,
      title: str(job.title),
      location: str((job.location as { name?: unknown } | undefined)?.name),
      url: httpsUrl(job.absolute_url),
      postedAt: isoDate(job.first_published ?? job.updated_at),
      description: "", // Greenhouse lists omit descriptions; read when the job is added
    }));
  } else if (board.kind === "lever") {
    jobs = (await leverPostings(token)).map((job) => {
      const categories = (job.categories ?? {}) as { location?: unknown; allLocations?: unknown };
      const lists = records(job.lists).map((list) => `${str(list.text)}\n${htmlToText(str(list.content))}`);
      return {
        externalId: str(job.id),
        company,
        title: str(job.text),
        location: str(categories.location) || (Array.isArray(categories.allLocations) ? categories.allLocations.map(str).join("; ") : ""),
        url: httpsUrl(job.hostedUrl),
        postedAt: isoDate(job.createdAt),
        description: [str(job.descriptionPlain) || htmlToText(str(job.description)), ...lists, str(job.additionalPlain)]
          .filter(Boolean)
          .join("\n\n"),
      };
    });
  } else {
    const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`)) as { jobs?: unknown };
    jobs = records(data?.jobs)
      .filter((job) => job.isListed !== false)
      .map((job) => ({
        externalId: str(job.id),
        company,
        title: str(job.title),
        location: [str(job.location), job.isRemote === true ? "Remote" : ""].filter(Boolean).join(" · "),
        url: httpsUrl(job.jobUrl),
        postedAt: isoDate(job.publishedAt),
        description: str(job.descriptionPlain) || htmlToText(str(job.descriptionHtml)),
      }));
  }
  return jobs.filter((job) => job.externalId && job.title && job.url).map((job) => ({
    ...job,
    title: job.title.slice(0, 200),
    location: job.location.slice(0, 200),
    company: job.company.slice(0, 160),
    description: job.description.slice(0, 20000),
  }));
}

export function phrases(text: string) {
  return text
    .split(/[,;\n]/)
    .map((part) => part.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Whole-word phrase match, so "tech" doesn't match "technology" and "IT" doesn't match "with".
function has(haystack: string, phrase: string) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

// Remote postings often name the country they hire in ("Remote - UK", "Remote, EMEA"). A remote job only counts when it
// names the U.S. or no country at all; one that names only other countries or regions is left out.
const US_PLACE = /\b(united states|usa|u\.s\.a?\.?|us|north america|americas)\b/i;
const NON_US_PLACE = new RegExp(`\\b(${[
  "canada", "mexico", "brazil", "argentina", "colombia", "chile", "peru", "costa rica", "latam", "latin america", "south america",
  "united kingdom", "uk", "england", "scotland", "wales", "ireland", "europe", "emea", "eu", "germany", "france", "spain", "portugal",
  "italy", "netherlands", "belgium", "switzerland", "austria", "poland", "romania", "ukraine", "sweden", "norway", "denmark", "finland",
  "czech republic", "czechia", "hungary", "greece", "turkey", "israel", "uae", "dubai", "saudi arabia", "egypt", "nigeria", "kenya",
  "south africa", "africa", "middle east", "india", "pakistan", "bangladesh", "philippines", "singapore", "malaysia", "indonesia",
  "vietnam", "thailand", "japan", "korea", "china", "hong kong", "taiwan", "apac", "asia", "australia", "new zealand", "anz",
  "london", "toronto", "vancouver", "montreal", "berlin", "paris", "amsterdam", "dublin", "madrid", "barcelona", "lisbon", "warsaw",
  "bangalore", "bengaluru", "hyderabad", "pune", "mumbai", "delhi", "manila", "sydney", "melbourne", "tokyo", "tel aviv",
].join("|")})\\b`, "i");

// Titles that ask for a language other than English ("French Audio Specialist", "Language Partner (Arabic)").
// They're left out unless the search itself names that language.
const LANGUAGES = [
  "afrikaans", "albanian", "amharic", "arabic", "armenian", "azerbaijani", "basque", "belarusian", "bengali", "bosnian",
  "bulgarian", "burmese", "cantonese", "catalan", "chinese", "croatian", "czech", "danish", "dutch", "estonian", "farsi",
  "filipino", "finnish", "flemish", "french", "georgian", "german", "greek", "gujarati", "hausa", "hebrew", "hindi",
  "hungarian", "icelandic", "igbo", "indonesian", "italian", "japanese", "kannada", "kazakh", "khmer", "korean", "kurdish",
  "lao", "latvian", "lithuanian", "macedonian", "malay", "malayalam", "maltese", "mandarin", "marathi", "mongolian",
  "nepali", "norwegian", "pashto", "persian", "polish", "portuguese", "punjabi", "romanian", "russian", "serbian",
  "sinhala", "slovak", "slovenian", "somali", "spanish", "swahili", "swedish", "tagalog", "tamil", "telugu", "thai",
  "tigrinya", "turkish", "ukrainian", "urdu", "uzbek", "vietnamese", "welsh", "yoruba", "zulu",
];

export function otherLanguageInTitle(title: string, search: Pick<JobSearch, "titleWords" | "locations">) {
  const wanted = `${search.titleWords} ${search.locations}`.toLowerCase();
  return LANGUAGES.some((language) => has(title, language) && !has(wanted, language));
}

export function isNonUsOnly(location: string) {
  return NON_US_PLACE.test(location) && !US_PLACE.test(location);
}

// Returns a 0-100 score for a job that matches the search, or null if it doesn't.
export function scoreJob(job: Pick<BoardJob, "title" | "location" | "postedAt">, search: JobSearch, now = Date.now()) {
  const title = job.title.toLowerCase();
  const location = job.location.toLowerCase();
  if (phrases(search.excludeWords).some((word) => has(title, word))) return null;
  if (otherLanguageInTitle(title, search)) return null;
  const titleWords = phrases(search.titleWords);
  const titleHit = titleWords.length === 0 || titleWords.some((word) => has(title, word));
  if (!titleHit) return null;
  const places = phrases(search.locations);
  const remote = /remote|anywhere/i.test(location) && !isNonUsOnly(location);
  const placeHit = places.some((place) => has(location, place) && !(/^(remote|anywhere)$/.test(place) && !remote));
  const remoteHit = search.remoteOk === "yes" && remote;
  if (places.length && location && !placeHit && !remoteHit) return null;
  let score = titleWords.length ? 55 : 30;
  if (placeHit) score += 30;
  else if (remoteHit) score += 25;
  else if (!places.length) score += 20;
  else score += 5; // no location listed: possible match, ranked lower
  const age = job.postedAt ? (now - new Date(job.postedAt).getTime()) / 86_400_000 : Infinity;
  score += age <= 7 ? 15 : age <= 30 ? 8 : 0;
  return Math.min(100, score);
}
