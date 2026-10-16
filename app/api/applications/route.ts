import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, tailoredVersions } from "@/db/schema";
import { apiError, clean, requireApiUser, safeUrl } from "../_lib";

const statuses = new Set(["saved", "ready", "applied", "interview", "rejected", "offer"]);

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const company = clean(payload.company, 160);
    const role = clean(payload.role, 200);
    if (!company || !role) {
      return Response.json({ error: "Company and role are required." }, { status: 400 });
    }
    const status = clean(payload.status, 30);
    const db = getDb();
    const [application] = await db
      .insert(applications)
      .values({
        id: crypto.randomUUID(),
        ownerEmail: user.email,
        company,
        role,
        location: clean(payload.location, 180),
        url: safeUrl(payload.url),
        status: statuses.has(status) ? status : "saved",
        resumeId: clean(payload.resumeId, 80) || null,
        notes: clean(payload.notes, 2000),
        jobDescription: clean(payload.jobDescription, 20000),
      })
      .returning();
    return Response.json({ application }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const id = clean(payload.id, 80);
    const status = clean(payload.status, 30);
    const updates: { status?: string; jobDescription?: string; updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
    if (status) updates.status = status;
    if (typeof payload.jobDescription === "string") updates.jobDescription = clean(payload.jobDescription, 20000);
    if (!id || (status && !statuses.has(status)) || (!updates.status && updates.jobDescription === undefined)) {
      return Response.json({ error: "A valid application and status are required." }, { status: 400 });
    }
    const db = getDb();
    const [application] = await db
      .update(applications)
      .set(updates)
      .where(and(eq(applications.id, id), eq(applications.ownerEmail, user.email)))
      .returning();
    if (!application) return Response.json({ error: "Application not found." }, { status: 404 });
    return Response.json({ application });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const id = clean(new URL(request.url).searchParams.get("id"), 80);
    if (!id) return Response.json({ error: "Application id required." }, { status: 400 });
    const db = getDb();
    await db.batch([
      db.delete(tailoredVersions).where(and(eq(tailoredVersions.applicationId, id), eq(tailoredVersions.ownerEmail, user.email))),
      db.delete(applications).where(and(eq(applications.id, id), eq(applications.ownerEmail, user.email))),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
