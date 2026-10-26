import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { cancelSubmissions, listSubmissions, resolveSubmission, saveSettings, submissionsPage } from "@/app/submission-store";
import { apiError, clean, requireApiUser, requireJson } from "../_lib";

export const dynamic = "force-dynamic";
const db = () => env.DB as unknown as SqlDatabase;

// The "Ready to send" panel: submissions, where each open application would be sent, settings and calibration.
// With ?id= it returns that one submission with its fill report.
export async function GET(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const id = clean(new URL(request.url).searchParams.get("id"), 80);
    if (id) return Response.json({ submissions: (await listSubmissions(db(), user.email, Date.now(), { id })).submissions });
    return Response.json(await submissionsPage(db(), user.email, Date.now()));
  } catch (error) {
    return apiError(error);
  }
}

// action "cancel" / "cancelAll": take back approvals not yet claimed. "resolve": your answer for one ApplyPilot couldn't confirm.
// "settings": automatic submitting settings.
export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notJson = requireJson(request);
  if (notJson) return notJson;
  try {
    const payload = (await request.json()) as unknown;
    if (!payload || typeof payload !== "object") return Response.json({ error: "The request was not valid." }, { status: 400 });
    const body = payload as Record<string, unknown>;
    const now = Date.now();
    if (body.action === "cancel") {
      return Response.json(await cancelSubmissions(db(), user.email, Array.isArray(body.ids) ? body.ids : [], now));
    }
    if (body.action === "cancelAll") return Response.json(await cancelSubmissions(db(), user.email, "all", now));
    if (body.action === "resolve") {
      return Response.json({ submission: await resolveSubmission(db(), user.email, body.id, body.outcome, now) });
    }
    if (body.action === "settings") return Response.json({ settings: await saveSettings(db(), user.email, body.settings, now) });
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
