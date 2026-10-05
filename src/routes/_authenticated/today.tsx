import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { WhatsAppButtons } from "@/components/WhatsAppButtons";
import {
  STATUS_LABEL,
  STATUS_TONE,
  distributeLeads,
  fetchForecast,
  fetchSenders,
  fetchTodayAssignments,
  formatArabicDate,
  isPending,
  markSent,
  setLeadNoWhatsapp,
  toISODate,
  todayISO,
  usesCapacity,
  type Forecast,
  type ForecastRow,
  type Sender,
  type TodayAssignment,
} from "@/lib/leads";

const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
};

export const Route = createFileRoute("/_authenticated/today")({
  head: () => ({
    meta: [
      { title: "إرسال اليوم — مِرسال" },
      {
        name: "description",
        content: "لوحة إرسال اليوم: عدد العملاء المخصص لكل رقم إرسال، وما تم إرساله والمتبقي.",
      },
      { property: "og:title", content: "إرسال اليوم — مِرسال" },
      {
        property: "og:description",
        content: "لوحة إرسال اليوم: عدد العملاء المخصص لكل رقم إرسال، وما تم إرساله والمتبقي.",
      },
    ],
  }),
  component: TodayPage,
});

function TodayPage() {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const today = todayISO();
  const isToday = date === today;
  // Future days aren't stored yet; they're shown as a forecast of the queue
  const isFuture = date > today;
  const senders = useQuery({ queryKey: ["senders"], queryFn: fetchSenders });
  const assignments = useQuery({
    queryKey: ["assignments", date],
    queryFn: () => fetchTodayAssignments(date),
  });
  const forecast = useQuery({
    queryKey: ["forecast", date],
    queryFn: () => fetchForecast(date),
    enabled: date >= today,
    retry: false,
  });

  const distribute = useMutation({
    mutationFn: () => distributeLeads(),
    onSuccess: (count) => {
      qc.invalidateQueries();
      toast.success(count > 0 ? `تم توزيع ${count} عميلاً على أرقام الإرسال` : "لا يوجد عملاء جدد للتوزيع");
    },
    onError: () => toast.error("تعذّر التوزيع"),
  });

  useEffect(() => {
    if (!isToday) return;
    distributeLeads()
      .then(() => qc.invalidateQueries())
      .catch(() => {});
  }, [qc, isToday]);

  const toggleSent = useMutation({
    mutationFn: ({ id, sent }: { id: string; sent: boolean }) => markSent(id, sent),
    // Opening WhatsApp backgrounds the page and can cut the request off; retry once it's back
    retry: 3,
    // Tick the box right away instead of waiting for the round trip
    onMutate: async ({ id, sent }) => {
      const key = ["assignments", date];
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TodayAssignment[]>(key);
      qc.setQueryData<TodayAssignment[]>(key, (list) =>
        list?.map((a) => (a.id === id ? { ...a, sent } : a)),
      );
      return { previous };
    },
    onError: (_err, _v, context) => {
      if (context?.previous) qc.setQueryData(["assignments", date], context.previous);
      toast.error("تعذّر تحديث الحالة");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["assignments", date] }),
  });

  const toggleNoWhatsapp = useMutation({
    mutationFn: ({ id, noWhatsapp }: { id: string; noWhatsapp: boolean }) =>
      setLeadNoWhatsapp(id, noWhatsapp),
    onSuccess: (_d, v) => {
      qc.invalidateQueries();
      toast.success(v.noWhatsapp ? "نُقل الرقم إلى قائمة «بدون واتساب»" : "أُعيد الرقم إلى القوائم العادية");
    },
    onError: () => toast.error("تعذّر تحديث الحالة"),
  });

  const activeSenders = (senders.data ?? []).filter((s) => s.active);
  const rows = assignments.data ?? [];
  const totalCapacity = activeSenders.reduce((sum, s) => sum + s.daily_limit, 0);
  const totalSent = rows.filter((a) => a.sent).length;
  const forecastRows = forecast.data?.rows ?? [];
  const dayLabel = isToday ? "اليوم" : formatArabicDate(new Date(`${date}T12:00:00`));

  const byS = (id: string) => rows.filter((a) => a.sender_id === id);
  // Stopped senders still show on days they have assignments
  const shownSenders = (senders.data ?? []).filter((s) => s.active || byS(s.id).length > 0);

  return (
    <AppShell
      badge={`${isFuture ? forecastRows.length : totalSent} / ${totalCapacity} ${dayLabel}`}
    >
      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDate(shiftDate(date, -1))}
              aria-label="اليوم السابق"
              className="glass rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              →
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="num glass rounded-lg px-3 py-1.5 text-xs outline-none"
            />
            <button
              onClick={() => setDate(shiftDate(date, 1))}
              aria-label="اليوم التالي"
              className="glass rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              ←
            </button>
            {!isToday && (
              <button
                onClick={() => setDate(todayISO())}
                className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                العودة لليوم
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {isFuture ? `${forecastRows.length} متوقَّع` : `${rows.length} مخصص`}
            </span>
            {isToday && (
              <button
                onClick={() => distribute.mutate()}
                disabled={distribute.isPending || activeSenders.length === 0}
                className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                توزيع العملاء الجدد
              </button>
            )}
          </div>
        </div>

        {date >= today ? (
          <QueueSummary
            data={forecast.data}
            failed={forecast.isError}
            today={today}
            onShowDay={setDate}
          />
        ) : null}

        {isFuture ? (
          <ForecastView senders={activeSenders} rows={forecastRows} />
        ) : shownSenders.length === 0 ? (
          <div className="glass rounded-2xl p-8 text-center text-sm text-muted-foreground">
            أضف أرقام الإرسال أولًا من صفحة «أرقام الإرسال»، ثم اضغط توزيع.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {shownSenders.map((s) => {
              const mine = byS(s.id);
              const sent = mine.filter((a) => a.sent).length;
              const used = mine.filter(usesCapacity).length;
              const pending = mine.filter(isPending).length;
              const pct = s.daily_limit ? Math.min(100, Math.round((sent / s.daily_limit) * 100)) : 0;
              const full = used >= s.daily_limit;
              return (
                <div key={s.id} className="rise glass rounded-2xl p-4 sm:p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="num text-[15px] font-semibold" dir="ltr">
                        {s.phone}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {s.label || "رقم إرسال"} · الحد {s.daily_limit}
                        {s.active ? null : " · موقوف"}
                      </div>
                    </div>
                    <div className="text-left">
                      <div
                        className={`num text-2xl font-bold leading-none ${full && sent >= s.daily_limit ? "text-accent" : "text-primary"}`}
                      >
                        {sent}
                      </div>
                      <div className="text-[10px] text-muted-foreground">مُرسَل</div>
                    </div>
                  </div>

                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`meter h-full rounded-full ${sent >= s.daily_limit ? "bg-accent" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] tabular-nums">
                    <span className="text-muted-foreground">المتبقي {pending}</span>
                    <span className={sent >= s.daily_limit ? "text-accent" : "text-primary"}>
                      {used} / {s.daily_limit}
                    </span>
                  </div>

                  <div className="mt-4 divide-y divide-border/70 border-t border-border">
                    {mine.length === 0 ? (
                      <p className="pt-3 text-xs text-muted-foreground">
                        لا عملاء مخصصون لهذا الرقم اليوم.
                      </p>
                    ) : (
                      mine.map((a) => (
                        <AssignmentRow
                          key={a.id}
                          a={a}
                          onToggle={toggleSent.mutate}
                          onNoWhatsapp={toggleNoWhatsapp.mutate}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function QueueSummary({
  data,
  failed,
  today,
  onShowDay,
}: {
  data: Forecast | undefined;
  failed: boolean;
  today: string;
  onShowDay: (date: string) => void;
}) {
  const box =
    "glass mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-2.5 text-xs";
  if (failed)
    return (
      <div className={`${box} text-accent`}>
        عرض الأيام القادمة يحتاج تشغيل ملف 0004_forecast_leads.sql في Supabase.
      </div>
    );
  if (!data) return null;
  if (data.queued === 0)
    return (
      <div className={`${box} text-muted-foreground`}>
        كل العملاء وُزِّعوا — لا يوجد أحد في الانتظار.
      </div>
    );
  if (data.capacity === 0)
    return (
      <div className={`${box} text-muted-foreground`}>
        <span className="num font-semibold text-foreground">{data.queued}</span> عميل في الانتظار —
        فعّل رقم إرسال ليتم توزيعهم.
      </div>
    );
  const lastDay = shiftDate(today, Math.ceil(data.queued / data.capacity));
  return (
    <div className={`${box} text-muted-foreground`}>
      <span>
        <span className="num font-semibold text-foreground">{data.queued}</span> عميل في الانتظار
        بعد اليوم · آخر دفعة يوم{" "}
        <span className="font-semibold text-foreground">
          {formatArabicDate(new Date(`${lastDay}T12:00:00`))}
        </span>
      </span>
      <span className="text-[11px]">
        لو لم تُرسل أرقام يوم، تُرحَّل لليوم التالي وتتأخر الخطة كلها يومًا.
      </span>
      <span className="flex gap-2">
        <button
          onClick={() => onShowDay(shiftDate(today, 1))}
          className="text-primary hover:underline"
        >
          عرض الغد
        </button>
        <button onClick={() => onShowDay(lastDay)} className="text-primary hover:underline">
          عرض آخر يوم
        </button>
      </span>
    </div>
  );
}

/** A future day: who each active sender is expected to message, from forecast_leads(). */
function ForecastView({ senders, rows }: { senders: Sender[]; rows: ForecastRow[] }) {
  if (senders.length === 0)
    return (
      <div className="glass rounded-2xl p-8 text-center text-sm text-muted-foreground">
        أضف أرقام الإرسال أولًا من صفحة «أرقام الإرسال».
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {senders.map((s) => {
        const mine = rows.filter((r) => r.sender_id === s.id);
        return (
          <div key={s.id} className="rise glass rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="num text-[15px] font-semibold" dir="ltr">
                  {s.phone}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.label || "رقم إرسال"} · الحد {s.daily_limit}
                </div>
              </div>
              <div className="text-left">
                <div className="num text-2xl font-bold leading-none text-primary">
                  {mine.length}
                </div>
                <div className="text-[10px] text-muted-foreground">متوقَّع</div>
              </div>
            </div>
            <div className="mt-4 space-y-2 border-t border-border pt-3">
              {mine.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  لا عملاء متبقون لهذا الرقم في هذا اليوم.
                </p>
              ) : (
                mine.map((r) => (
                  <div key={r.lead_id} className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm">{r.name || r.phone}</span>
                    <span className="num shrink-0 text-[11px] text-muted-foreground" dir="ltr">
                      {r.phone}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AssignmentRow({
  a,
  onToggle,
  onNoWhatsapp,
}: {
  a: TodayAssignment;
  onToggle: (v: { id: string; sent: boolean }) => void;
  onNoWhatsapp: (v: { id: string; noWhatsapp: boolean }) => void;
}) {
  const lead = a.leads;
  const noWa = lead?.no_whatsapp ?? false;
  // Distributed on an earlier day and carried over by distribute_leads() because it wasn't sent
  const assignedOn = new Date(a.created_at);
  const rolledOver = toISODate(assignedOn) < a.assign_date;
  const chip = "rounded-md px-2.5 py-1.5 text-xs sm:px-2 sm:py-0.5 sm:text-[11px]";
  return (
    // Phone: name/number on one line, the buttons wrap underneath instead of squeezing them
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5">
      <label className="flex min-w-[12rem] flex-1 items-center gap-2.5">
        <input
          type="checkbox"
          checked={a.sent}
          onChange={(e) => onToggle({ id: a.id, sent: e.target.checked })}
          className="size-5 shrink-0 accent-primary sm:size-4"
        />
        <span className="flex min-w-0 flex-col items-start">
          <span
            className={`max-w-full truncate text-sm ${noWa ? "text-muted-foreground line-through" : ""}`}
          >
            {lead?.name || lead?.phone}
          </span>
          <span className="num text-[11px] text-muted-foreground" dir="ltr">
            {lead?.phone}
          </span>
        </span>
        {rolledOver ? (
          <span
            title={`مُرحَّل من ${formatArabicDate(assignedOn)}`}
            className="shrink-0 rounded-md bg-warning px-1.5 py-0.5 text-[10px] text-warning-foreground"
          >
            مُرحَّل
          </span>
        ) : null}
      </label>
      <div className="flex flex-wrap items-center gap-1.5 ps-7.5 sm:ps-0">
        {lead && !noWa ? (
          <WhatsAppButtons
            phone={lead.phone}
            onOpen={() => {
              if (!a.sent) onToggle({ id: a.id, sent: true });
            }}
          />
        ) : null}
        {lead ? (
          <button
            onClick={() => onNoWhatsapp({ id: lead.id, noWhatsapp: !noWa })}
            title={noWa ? "إعادة الرقم إلى واتساب" : "الرقم ليس لديه واتساب"}
            className={`${chip} ring-1 transition-colors ${
              noWa
                ? "bg-accent/15 text-accent ring-accent/30"
                : "text-muted-foreground ring-border hover:text-foreground"
            }`}
          >
            {noWa ? "بدون واتساب ✕" : "بدون واتساب؟"}
          </button>
        ) : null}
        {lead ? (
          <span className={`${chip} ${STATUS_TONE[lead.status]}`}>{STATUS_LABEL[lead.status]}</span>
        ) : null}
      </div>
    </div>
  );
}
