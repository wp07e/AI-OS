import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { AppHeader } from "./_components/AppHeader";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const container = getContainerForUser(user.id);
  if (!container || container.status !== "ready") redirect("/launching");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AppHeader
        user={{
          username: user.username,
          displayName: user.display_name ?? user.username,
          avatarUrl: user.avatar_url,
        }}
      />
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
