import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CalendarCheck, History, Smartphone, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatArabicDate } from "@/lib/leads";

const tabs = [
  { to: "/today", label: "لوحة اليوم", short: "اليوم", Icon: CalendarCheck },
  { to: "/clients", label: "العملاء", short: "العملاء", Icon: Users },
  { to: "/senders", label: "أرقام الإرسال", short: "الأرقام", Icon: Smartphone },
  { to: "/log", label: "السجل", short: "السجل", Icon: History },
] as const;

export function AppShell({ children, badge }: { children: ReactNode; badge?: string }) {
  const router = useRouter();

  const signOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-[-18%] right-[-8%] size-[560px] rounded-full bg-glow-a blur-[110px]" />
        <div className="absolute top-[42%] left-[-12%] size-[520px] rounded-full bg-glow-b blur-[120px]" />
        <div className="absolute bottom-[-16%] right-[28%] size-[440px] rounded-full bg-accent/20 blur-[120px]" />
      </div>

      {/* Phone: room for the bottom tab bar and the notch / home indicator (installed app) */}
      <div className="mx-auto max-w-[1400px] px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
        <header className="rise flex flex-wrap items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground sm:size-10">
              م
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight">مِرسال</div>
              <div className="hidden text-xs text-muted-foreground sm:block">
                توزيع العملاء على أرقام الإرسال
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs sm:gap-3">
            <span className="glass hidden rounded-full px-3 py-1.5 sm:inline">
              اليوم — {formatArabicDate()}
            </span>
            {badge ? (
              <span className="rounded-full bg-primary/10 px-3 py-1.5 tabular-nums text-primary">
                {badge}
              </span>
            ) : null}
            <button
              onClick={signOut}
              className="rounded-full px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              خروج
            </button>
          </div>
        </header>

        <nav className="rise glass mt-6 hidden gap-1 rounded-xl p-1 sm:inline-flex">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-primary data-[status=active]:text-primary-foreground"
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        {children}
      </div>

      {/* Phone: app-style tab bar pinned to the bottom */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
        <div className="grid grid-cols-4">
          {tabs.map(({ to, short, Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground transition-colors data-[status=active]:text-primary"
            >
              <Icon className="size-5" aria-hidden />
              {short}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
