import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import {
  addSender,
  deleteSender,
  fetchSenders,
  toISODate,
  type Assignment,
  type Lead,
} from "@/lib/leads";

type SentRow = Assignment & { leads: Lead | null };

async function fetchSentLog() {
  const { data, error } = await supabase
    .from("assignments")
    .select("*, leads(*)")
    .eq("sent", true)
    .order("sent_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SentRow[];
}

// sent_at is a UTC timestamp; group by the local day it was sent
const dayOf = (r: SentRow) => (r.sent_at ? toISODate(new Date(r.sent_at)) : r.assign_date);
const fmtDay = (iso: string) =>
  new Intl.DateTimeFormat("ar-EG", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(iso + "T12:00:00"),
  );

export const Route = createFileRoute("/_authenticated/log")({
  head: () => ({
    meta: [
      { title: "السجل — مِرسال" },
      { name: "description", content: "سجل نشاط كل رقم إرسال: الأرقام المرسلة وعددها يوميًا." },
      { property: "og:title", content: "السجل — مِرسال" },
      { property: "og:description", content: "سجل نشاط كل رقم إرسال: الأرقام المرسلة وعددها يوميًا." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LogPage,
});

function LogPage() {
  const qc = useQueryClient();
  const senders = useQuery({ queryKey: ["senders"], queryFn: fetchSenders });
  const log = useQuery({ queryKey: ["sent-log"], queryFn: fetchSentLog });
  const all = log.data ?? [];
  const orphans = all.filter((r) => r.sender_id === null);

  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");

  const add = useMutation({
    mutationFn: () => addSender({ phone, label, daily_limit: 20 }),
    onSuccess: () => {
      setPhone("");
      setLabel("");
      qc.invalidateQueries({ queryKey: ["senders"] });
      toast.success("تمت إضافة رقم الإرسال");
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "DUPLICATE")
        toast.error("هذا الرقم مضاف مسبقًا");
      else toast.error("تعذّرت الإضافة");
    },
  });

  const remove = useMutation({
    mutationFn: deleteSender,
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("تم حذف رقم الإرسال");
    },
    onError: () => toast.error("تعذّر الحذف"),
  });

  return (
    <AppShell badge={`${all.length} رسالة مُرسلة`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="glass rise mt-6 flex flex-wrap items-center gap-2 rounded-2xl p-4"
      >
        <span className="text-[13px] font-semibold text-muted-foreground">إضافة رقم إرسال</span>
        <input
          dir="ltr"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+966500000000"
          className="num min-w-[200px] flex-1 rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="وصف الرقم"
          className="w-40 rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
        />
        <button
          type="submit"
          disabled={add.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          إضافة
        </button>
      </form>

      <div className="mt-4 space-y-4">
        {(senders.data ?? []).length === 0 && orphans.length === 0 ? (
          <div className="glass rounded-2xl p-8 text-center text-sm text-muted-foreground">
            لا توجد أرقام إرسال بعد.
          </div>
        ) : null}
        {(senders.data ?? []).map((s) => (
          <SenderLog
            key={s.id}
            title={
              <div className="num text-base font-semibold" dir="ltr">
                {s.phone}
              </div>
            }
            subtitle={s.label || "رقم إرسال"}
            rows={all.filter((r) => r.sender_id === s.id)}
            onDelete={() => {
              if (
                !window.confirm(
                  "حذف هذا الرقم؟ سجل إرساله هيفضل محفوظ، والعملاء اللي لسه ما اتبعتلهمش هيرجعوا للتوزيع.",
                )
              )
                return;
              remove.mutate(s.id);
            }}
          />
        ))}
        {orphans.length > 0 ? (
          <SenderLog
            title={<div className="text-base font-semibold">أرقام محذوفة</div>}
            subtitle="سجل الإرسال من أرقام تم حذفها"
            rows={orphans}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function SenderLog({
  title,
  subtitle,
  rows,
  onDelete,
}: {
  title: ReactNode;
  subtitle: string;
  rows: SentRow[];
  onDelete?: () => void;
}) {
  const days = new Map<string, SentRow[]>();
  rows.forEach((r) => {
    const d = dayOf(r);
    days.set(d, [...(days.get(d) ?? []), r]);
  });
  return (
    <section className="rise glass overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-6 w-1.5 rounded-full bg-primary" aria-hidden />
          <div>
            {title}
            <div className="text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-primary/10 px-3 py-1.5 text-primary">
            إجمالي المرسل: <span className="num font-semibold">{rows.length}</span>
          </span>
          <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">
            أيام النشاط: <span className="num font-semibold">{days.size}</span>
          </span>
          {onDelete ? (
            <button
              onClick={onDelete}
              title="حذف الرقم"
              className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent"
            >
              <Trash2 className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="border-t border-border">
        {days.size === 0 ? (
          <p className="p-5 text-center text-sm text-muted-foreground">
            لم يُرسل من هذا الرقم بعد.
          </p>
        ) : (
          [...days.entries()].map(([d, list]) => <DayRow key={d} day={d} list={list} />)
        )}
      </div>
    </section>
  );
}

function DayRow({ day, list }: { day: string; list: SentRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-3 text-sm transition-colors hover:bg-muted/40"
      >
        <span className="font-medium">{fmtDay(day)}</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="num rounded-full bg-card px-2.5 py-0.5 text-xs ring-1 ring-border">
            {list.length} رقم
          </span>
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open ? (
        <ul className="grid gap-1.5 bg-muted/20 px-5 py-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-lg bg-card px-3 py-2 text-xs ring-1 ring-border">
              <span className="num" dir="ltr">{r.leads?.phone ?? "—"}</span>
              <span className="text-muted-foreground">{r.leads?.name || ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
