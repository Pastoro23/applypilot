import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { refreshAll } from "@/app/discovery-store";
import { apiError, requireApiUser } from "../../_lib";

// Re-reads every followed board (each at most once a minute) and updates the found-jobs list.
export async function POST() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    return Response.json(await refreshAll(env.DB as unknown as SqlDatabase, user.email));
  } catch (error) {
    return apiError(error);
  }
}
