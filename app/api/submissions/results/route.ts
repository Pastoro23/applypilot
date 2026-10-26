import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { recordResults } from "@/app/submission-store";
import { apiError, requireApiUser, requireJson } from "../../_lib";

// What happened to each job in Chrome. Results are deduped by resultId, so the dashboard can safely send them again.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notJson = requireJson(request);
  if (notJson) return notJson;
  try {
    const payload = (await request.json()) as unknown;
    const results = payload && typeof payload === "object" ? (payload as Record<string, unknown>).results : undefined;
    return Response.json(await recordResults(env.DB as unknown as SqlDatabase, user.email, results, Date.now()));
  } catch (error) {
    return apiError(error);
  }
}
