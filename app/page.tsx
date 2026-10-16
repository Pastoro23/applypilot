import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import DashboardShell from "./dashboard-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <DashboardShell
      user={user ? { displayName: user.displayName, email: user.email } : null}
      signInPath={chatGPTSignInPath("/")}
    />
  );
}
