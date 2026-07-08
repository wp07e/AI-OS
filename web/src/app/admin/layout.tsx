import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.is_admin) redirect("/app");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--card)]/60 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-gradient-to-br from-indigo-500 to-sky-400 shadow" />
            <span className="text-sm font-semibold tracking-tight">AI OS</span>
            <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
              ADMIN
            </span>
          </div>
        </div>
        <a
          href="/app"
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
        >
          &larr; Back to App
        </a>
      </header>
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
