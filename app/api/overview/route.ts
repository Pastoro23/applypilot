import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, applications, profiles, resumes } from "@/db/schema";
import { apiError, ensureStarterData, requireApiUser } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  try {
    await ensureStarterData(user.email);
    const db = getDb();
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.ownerEmail, user.email))
      .limit(1);
    const resumeRows = await db
      .select()
      .from(resumes)
      .where(eq(resumes.ownerEmail, user.email));
    const applicationRows = await db
      .select()
      .from(applications)
      .where(eq(applications.ownerEmail, user.email))
      .orderBy(desc(applications.updatedAt));
    const accountRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerEmail, user.email))
      .orderBy(desc(accounts.updatedAt));

    return Response.json({
      profile,
      resumes: resumeRows,
      applications: applicationRows,
      accounts: accountRows,
    });
  } catch (error) {
    return apiError(error);
  }
}
