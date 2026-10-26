import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { masterResumes } from "@/db/schema";
import { assertAiConfigured, extractProfileRecords } from "@/app/ai";
import { runAiOperation, type SqlDatabase } from "@/app/ai-operations";
import { cleanRecords, educationFields, workFields, type EducationRecord, type WorkRecord } from "@/app/profile-records";
import { apiError, requireApiUser, requireJson } from "../../_lib";

// Reads the saved resume into work history and education for the profile form. Nothing is saved here:
// the dashboard shows the result so you can check it and save the profile yourself.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notJson = requireJson(request);
  if (notJson) return notJson;
  try {
    const [resume] = await getDb().select().from(masterResumes).where(eq(masterResumes.ownerEmail, user.email));
    if (!resume?.content) return Response.json({ error: "Save your resume in Resume matcher first." }, { status: 400 });
    assertAiConfigured();
    const records = await runAiOperation(env.DB as unknown as SqlDatabase, user.email, "records",
      { version: 1, content: resume.content }, () => extractProfileRecords(resume.content));
    return Response.json({
      workHistory: cleanRecords<WorkRecord>(records.workHistory, workFields),
      education: cleanRecords<EducationRecord>(records.education, educationFields),
    });
  } catch (error) {
    return apiError(error);
  }
}
