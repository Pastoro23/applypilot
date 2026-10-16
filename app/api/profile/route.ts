import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { profiles } from "@/db/schema";
import { apiError, clean, ensureStarterData, requireApiUser } from "../_lib";

const fields = [
  "firstName",
  "lastName",
  "legalName",
  "profileEmail",
  "phone",
  "city",
  "state",
  "postalCode",
  "country",
  "linkedIn",
  "workAuthorization",
  "sponsorship",
  "availability",
  "relocation",
  "identityStatus",
  "locationStatus",
  "workHistoryStatus",
] as const;

export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  try {
    await ensureStarterData(user.email);
    const payload = (await request.json()) as Record<string, unknown>;
    const updates: Record<string, string> = { updatedAt: new Date().toISOString() };
    for (const field of fields) updates[field] = clean(payload[field], 500);
    const db = getDb();
    const [profile] = await db
      .update(profiles)
      .set(updates)
      .where(eq(profiles.ownerEmail, user.email))
      .returning();
    return Response.json({ profile });
  } catch (error) {
    return apiError(error);
  }
}
