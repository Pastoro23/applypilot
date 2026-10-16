import { getDb } from "@/db";
import { accounts } from "@/db/schema";
import { apiError, clean, requireApiUser, safeUrl } from "../_lib";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.password || payload.passwordValue) {
      return Response.json(
        { error: "Passwords are never stored here. Save them in Apple Passwords." },
        { status: 400 },
      );
    }
    const company = clean(payload.company, 160);
    const loginEmail = clean(payload.loginEmail, 260);
    if (!company || !loginEmail) {
      return Response.json({ error: "Company and login email are required." }, { status: 400 });
    }
    const db = getDb();
    const [account] = await db
      .insert(accounts)
      .values({
        id: crypto.randomUUID(),
        ownerEmail: user.email,
        company,
        loginEmail,
        loginUrl: safeUrl(payload.loginUrl),
        passwordManagerStatus: "save_in_apple_passwords",
        verificationStatus: "pending",
      })
      .returning();
    return Response.json({ account }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
