import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { loadSearch, MAX_SOURCES } from "@/app/discovery-store";
import { boardUrl, parseBoard } from "@/app/job-discovery";
import { apiError, clean, requireApiUser } from "../_lib";

export const dynamic = "force-dynamic";
const db = () => env.DB as unknown as SqlDatabase;

export async function GET() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const sources = (await db().prepare(`SELECT id, kind, token, label, last_checked_at AS lastCheckedAt, last_error AS lastError
      FROM job_sources WHERE owner_email = ? ORDER BY created_at`).bind(user.email).all<{ kind: "greenhouse" | "lever" | "ashby"; token: string }>()).results
      .map((source) => ({ ...source, url: boardUrl(source) }));
    const jobs = (await db().prepare(`SELECT f.id, f.company, f.title, f.location, f.url, f.posted_at AS postedAt, f.score, f.status,
      f.application_id AS applicationId, f.found_at AS foundAt
      FROM found_jobs f WHERE f.owner_email = ? AND f.status IN ('new', 'queued')
      ORDER BY f.status = 'queued', f.score DESC, f.posted_at DESC LIMIT 300`).bind(user.email).all()).results;
    return Response.json({ search: await loadSearch(db(), user.email), sources, jobs });
  } catch (error) {
    return apiError(error);
  }
}

// Save the search filters.
export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const search = {
      titleWords: clean(payload.titleWords, 500),
      locations: clean(payload.locations, 500),
      excludeWords: clean(payload.excludeWords, 500),
      remoteOk: payload.remoteOk === "no" ? "no" : "yes",
    };
    await db().prepare(`INSERT INTO job_searches (owner_email, title_words, locations, exclude_words, remote_ok, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_email) DO UPDATE SET title_words = excluded.title_words,
      locations = excluded.locations, exclude_words = excluded.exclude_words, remote_ok = excluded.remote_ok, updated_at = excluded.updated_at`)
      .bind(user.email, search.titleWords, search.locations, search.excludeWords, search.remoteOk, new Date().toISOString()).run();
    // Re-check every board against the new filters on the next refresh.
    await db().prepare("UPDATE job_sources SET last_checked_at = NULL WHERE owner_email = ?").bind(user.email).run();
    return Response.json({ search });
  } catch (error) {
    return apiError(error);
  }
}

// Follow a company's job board.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const board = parseBoard(clean(payload.board, 500));
    if (!board) {
      return Response.json({ error: "Paste a company's Greenhouse, Lever or Ashby jobs link, like jobs.lever.co/company." }, { status: 400 });
    }
    const count = await db().prepare("SELECT count(*) AS n FROM job_sources WHERE owner_email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_SOURCES) return Response.json({ error: `You can follow up to ${MAX_SOURCES} companies.` }, { status: 400 });
    await db().prepare(`INSERT OR IGNORE INTO job_sources (id, owner_email, kind, token, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), user.email, board.kind, board.token, clean(payload.label, 120), new Date().toISOString()).run();
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

// Stop following a board. Jobs already added to Applications stay there.
export async function DELETE(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const id = clean(new URL(request.url).searchParams.get("id"), 80);
    await db().batch([
      db().prepare("DELETE FROM found_jobs WHERE owner_email = ? AND source_id = ? AND status = 'new'").bind(user.email, id),
      db().prepare("DELETE FROM job_sources WHERE owner_email = ? AND id = ?").bind(user.email, id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
