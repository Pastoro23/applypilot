import { and, desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { applications, masterResumes, tailoredVersions } from "@/db/schema";
import { assertAiConfigured, TailoredResumeSchema, tailorResume } from "@/app/ai";
import { runAiOperation, type SqlDatabase } from "@/app/ai-operations";
import { saveTailoredVersion } from "@/app/tailored-store";
import { apiError, clean, requireApiUser } from "../_lib";

async function findApplication(id: string, owner: string) {
  const [application] = await getDb().select().from(applications)
    .where(and(eq(applications.id, id), eq(applications.ownerEmail, owner)));
  return application;
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const application = await findApplication(clean(payload.applicationId, 80), user.email);
    if (!application) return Response.json({ error: "Application not found." }, { status: 404 });
    if (payload.revision !== application.tailoredRevision) {
      return Response.json({ error: "This resume changed. Reload before tailoring again." }, { status: 409 });
    }
    if (payload.jobDescription !== application.jobDescription) {
      return Response.json({ error: "The job description changed. Reload before tailoring." }, { status: 409 });
    }
    if (application.jobDescription.trim().length < 100) {
      return Response.json({ error: "Add the job description first so the AI knows what to tailor to." }, { status: 400 });
    }
    const [source] = await getDb().select().from(masterResumes).where(eq(masterResumes.ownerEmail, user.email));
    if (!source?.content) return Response.json({ error: "Save your reviewed resume under Resume matcher first." }, { status: 400 });
    const input = {
      sourceResume: source.content, jobTitle: application.role, company: application.company,
      jobDescription: application.jobDescription, instructions: clean(payload.instructions, 1000),
    };
    assertAiConfigured();
    const tailored = await runAiOperation(env.DB as unknown as SqlDatabase, user.email, 'tailor',
      { version: 2, ...input }, () => tailorResume(input));
    // Recheck source/description/revision atomically: a late AI response cannot erase newer edits.
    await saveTailoredVersion(env.DB as unknown as SqlDatabase, {
      id: application.id, owner: user.email, revision: application.tailoredRevision,
      tailored, description: application.jobDescription, sourceResume: source.content,
    });
    return Response.json({ application: await findApplication(application.id, user.email) });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (JSON.stringify(payload.tailored ?? null).length > 180_000) return Response.json({ error: "The edited resume is too large." }, { status: 400 });
    const parsed = TailoredResumeSchema.safeParse(payload.tailored);
    if (!parsed.success || !Number.isSafeInteger(payload.revision)) return Response.json({ error: "The edited resume is incomplete." }, { status: 400 });
    const id = clean(payload.applicationId, 80);
    if (!await findApplication(id, user.email)) return Response.json({ error: "Application not found." }, { status: 404 });
    await saveTailoredVersion(env.DB as unknown as SqlDatabase, { id, owner: user.email, revision: payload.revision as number, tailored: parsed.data });
    return Response.json({ application: await findApplication(id, user.email) });
  } catch (error) { return apiError(error); }
}

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const id = clean(new URL(request.url).searchParams.get('applicationId'), 80);
    if (!await findApplication(id, user.email)) return Response.json({ error: "Application not found." }, { status: 404 });
    const versions = await getDb().select().from(tailoredVersions)
      .where(and(eq(tailoredVersions.applicationId, id), eq(tailoredVersions.ownerEmail, user.email)))
      .orderBy(desc(tailoredVersions.revision)).limit(20);
    return Response.json({ versions });
  } catch (error) { return apiError(error); }
}
