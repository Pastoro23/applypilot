import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { applications } from "@/db/schema";
import type { SqlDatabase } from "@/app/ai-operations";
import { queueFoundJob, setFoundJobStatus } from "@/app/discovery-store";
import { readJobPosting } from "@/app/job-posting";
import { apiError, clean, requireApiUser } from "../../_lib";

// action "add": move a found job into Applications. "dismiss" / "restore": hide or show it in the list.
export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const id = clean(payload.id, 80);
    const db = env.DB as unknown as SqlDatabase;
    if (payload.action === "dismiss" || payload.action === "restore") {
      await setFoundJobStatus(db, user.email, id, payload.action === "dismiss" ? "dismissed" : "new");
      return Response.json({ ok: true });
    }
    if (payload.action !== "add") return Response.json({ error: "Unknown action." }, { status: 400 });
    const result = await queueFoundJob(db, user.email, id, async (url) => (await readJobPosting(url)).description);
    const [application] = await getDb().select().from(applications)
      .where(and(eq(applications.id, result.applicationId), eq(applications.ownerEmail, user.email)));
    return Response.json({ application, descriptionMissing: result.descriptionMissing });
  } catch (error) {
    return apiError(error);
  }
}
