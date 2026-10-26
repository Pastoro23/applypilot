import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/app/ai-operations";
import { claimSubmission } from "@/app/submission-store";
import { apiError, requireApiUser, requireJson } from "../../_lib";

// The single-use go-ahead the extension asks for, through the dashboard tab, right before Submit is clicked or offered.
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notJson = requireJson(request);
  if (notJson) return notJson;
  try {
    return Response.json(await claimSubmission(env.DB as unknown as SqlDatabase, user.email, await request.json(), Date.now()));
  } catch (error) {
    return apiError(error);
  }
}
