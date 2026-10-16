import { JobReadError, readJobPosting } from "@/app/job-posting";
import { apiError, requireApiUser, safeUrl } from "../_lib";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const url = safeUrl(payload.url);
    if (!url) return Response.json({ error: "Paste a full job link that starts with https://." }, { status: 400 });
    try {
      const posting = await readJobPosting(url);
      return Response.json({ posting });
    } catch (reason) {
      console.error(reason);
      const message =
        reason instanceof JobReadError ? reason.message : "ApplyPilot couldn't read that job page. Paste the description instead.";
      return Response.json({ error: message }, { status: 422 });
    }
  } catch (error) {
    return apiError(error);
  }
}
