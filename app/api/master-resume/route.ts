import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { masterResumes } from "@/db/schema";
import { assertAiConfigured, resumePdfToText } from "@/app/ai";
import { runAiOperation, type SqlDatabase } from "@/app/ai-operations";
import { UserFacingError } from "@/app/errors";
import { apiError, clean, requireApiUser } from "../_lib";

const MAX_RESUME_CHARS = 30000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

export async function GET() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const [resume] = await getDb().select().from(masterResumes).where(eq(masterResumes.ownerEmail, user.email));
    return Response.json({ resume: resume ?? null });
  } catch (error) { return apiError(error); }
}

// This explicit save is the only operation that can replace the master resume.
export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (content.length < 200 || content.length > MAX_RESUME_CHARS) {
      return Response.json({ error: "Use resume text between 200 and 30,000 characters." }, { status: 400 });
    }
    const values = { content, sourceFilename: clean(payload.sourceFilename, 200), updatedAt: new Date().toISOString() };
    const [resume] = await getDb().insert(masterResumes).values({ ownerEmail: user.email, ...values })
      .onConflictDoUpdate({ target: masterResumes.ownerEmail, set: values }).returning();
    return Response.json({ resume });
  } catch (error) { return apiError(error); }
}

// Extract to a preview only. Uploading must never overwrite the saved master.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const declaredSize = Number(request.headers.get('content-length') || 0);
    if (declaredSize > MAX_PDF_BYTES + 64 * 1024) return Response.json({ error: "The PDF must be under 5 MB." }, { status: 413 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a PDF file." }, { status: 400 });
    if (file.size === 0 || file.size > MAX_PDF_BYTES) return Response.json({ error: "Choose a PDF under 5 MB." }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      return Response.json({ error: "Upload a PDF, or paste the resume text instead." }, { status: 400 });
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const base64 = btoa(binary);
    assertAiConfigured();
    const extraction = await runAiOperation(env.DB as unknown as SqlDatabase, user.email, 'pdf',
      { version: 1, base64 }, async () => {
        const content = (await resumePdfToText(base64)).trim();
        if (content.length < 200 || content.length > MAX_RESUME_CHARS) {
          throw new UserFacingError('Could not extract a complete resume between 200 and 30,000 characters. Paste the full text instead.', 422);
        }
        return { content };
      });
    return Response.json({ extraction: { ...extraction, sourceFilename: clean(file.name, 200) } });
  } catch (error) { return apiError(error); }
}
