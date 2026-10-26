import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { approveForSubmit } from "@/app/submission-store";
import { apiError, requireApiUser, requireJson } from "../../_lib";

// Your tap on "Approve & send": one approval per job, valid for 24 hours, tied to that resume revision and profile.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notJson = requireJson(request);
  if (notJson) return notJson;
  try {
    const payload = (await request.json()) as unknown;
    if (!payload || typeof payload !== "object") return Response.json({ error: "The request was not valid." }, { status: 400 });
    const body = payload as Record<string, unknown>;
    return Response.json(await approveForSubmit(env.DB as unknown as SqlDatabase, user.email, body.items, {
      includeCoverLetter: body.includeCoverLetter, now: Date.now(),
    }));
  } catch (error) {
    return apiError(error);
  }
}
