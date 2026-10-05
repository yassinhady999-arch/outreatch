import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "الدخول — مِرسال" },
      { name: "description", content: "سجّل الدخول لإدارة توزيع العملاء على أرقام الإرسال." },
      { property: "og:title", content: "الدخول — مِرسال" },
      { property: "og:description", content: "سجّل الدخول لإدارة توزيع العملاء على أرقام الإرسال." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.navigate({ to: "/today" });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (data.session) router.navigate({ to: "/today" });
        else toast.success("أرسلنا لك رسالة تأكيد على بريدك، افتحها لتفعيل الحساب.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذّر إكمال العملية");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 text-foreground">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-[-18%] right-[-8%] size-[560px] rounded-full bg-glow-a blur-[110px]" />
        <div className="absolute bottom-[-16%] left-[-10%] size-[480px] rounded-full bg-glow-b blur-[120px]" />
      </div>

      <div className="rise glass w-full max-w-sm rounded-2xl p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">
            م
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight">مِرسال</div>
            <div className="text-xs text-muted-foreground">توزيع العملاء على أرقام الإرسال</div>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-2">
          <input
            dir="ltr"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="w-full rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
          />
          <input
            dir="ltr"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {mode === "in" ? "دخول" : "إنشاء حساب"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "in" ? "up" : "in")}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          {mode === "in" ? "ليس لديك حساب؟ إنشاء حساب جديد" : "لديك حساب؟ الدخول"}
        </button>
      </div>
    </div>
  );
}
