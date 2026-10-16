import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { profiles, resumes } from "@/db/schema";
import { UserFacingError } from "@/app/errors";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { resumeSeeds } from "@/app/resume-seeds";

export async function requireApiUser() {
  return getChatGPTUser();
}

export function apiError(error: unknown) {
  if (error instanceof UserFacingError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "Unexpected error";
  if (message.includes("no such table") || message.includes("no such column")) {
    return Response.json(
      { error: "The database is being prepared. Refresh in a moment." },
      { status: 503 },
    );
  }
  console.error(error);
  if (error instanceof SyntaxError) return Response.json({ error: "The request was not valid JSON." }, { status: 400 });
  return Response.json({ error: "Something went wrong. Try again." }, { status: 500 });
}

export function clean(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function safeUrl(value: unknown) {
  const candidate = clean(value, 1200);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function ensureStarterData(ownerEmail: string) {
  const db = getDb();
  await db
    .insert(profiles)
    .values({
      ownerEmail,
      firstName: "Peter",
      lastName: "Olatunde",
      legalName: "",
      profileEmail: "pastorolatunde13@gmail.com",
      phone: "404-499-6308",
      city: "Grayson",
      state: "GA",
      postalCode: "30017",
      country: "United States",
      linkedIn: "https://www.linkedin.com/in/peter-olatunde-8b027123b",
      workAuthorization: "Authorized to work in the U.S. — confirm exact wording",
      sponsorship: "No sponsorship expected — confirm before first application",
      availability: "",
      relocation: "",
    })
    .onConflictDoNothing();

  const existing = await db
    .select({ slug: resumes.slug })
    .from(resumes)
    .where(eq(resumes.ownerEmail, ownerEmail));
  const existingSlugs = new Set(existing.map((row) => row.slug));
  const missing = resumeSeeds.filter((resume) => !existingSlugs.has(resume.slug));
  if (missing.length) {
    await db.insert(resumes).values(
      missing.map((resume) => ({
        id: crypto.randomUUID(),
        ownerEmail,
        ...resume,
      })),
    );
  }
}
