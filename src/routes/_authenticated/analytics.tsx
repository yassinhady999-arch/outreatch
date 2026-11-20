import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AppShell } from "@/components/AppShell";
import { fetchCategories, fetchLeads, fetchSenders } from "@/lib/leads";
import {
  buildAnalytics,
  fetchAssignmentsLite,
  formatMinutes,
  pct,
  type AnalyticsLead,
  type Range,
  type Row,
} from "@/lib/analytics";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "التحليلات — مِرسال" },
      { name: "description", content: "نسبة رد العيادات وتحليلات الإرسال يوم بيوم وحسب الوقت والفئة والمدينة." },
      { property: "og:title", content: "التحليلات — مِرسال" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: AnalyticsPage,
});

// Chart colors: the site's teal stepped up to clear the chroma floor, and its orange.
// Validated together on the card surface (#f8f9f9): every check passes, CVD ΔE 11.3.
const TEAL = "#007d66";
const ORANGE = "#bd4700";
const GRID = "#e4e7e7"; // hairline, one step off the card
const AXIS = "#6f7b78"; // muted ink

const RANGES: { value: Range; label: string }[] = [
  { value: 7, label: "آخر 7 أيام" },
  { value: 30, label: "آخر 30 يوم" },
  { value: 90, label: "آخر 90 يوم" },
  { value: 0, label: "من الأول" },
];

const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat("ar-EG-u-nu-latn", { day: "numeric", month: "short" }).format(
    new Date(`${iso}T12:00:00`),
  );
const fullDay = (iso: string) =>
  new Intl.DateTimeFormat("ar-EG-u-nu-latn", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${iso}T12:00:00`),
  );
const n = (x: number) => x.toLocaleString("en-US");

function AnalyticsPage() {
  const leads = useQuery({ queryKey: ["leads"], queryFn: fetchLeads });
  const assignments = useQuery({ queryKey: ["assignments-lite"], queryFn: fetchAssignmentsLite });
  const categories = useQuery({ queryKey: ["categories"], queryFn: fetchCategories });
  const senders = useQuery({ queryKey: ["senders"], queryFn: fetchSenders });

  const [range, setRange] = useState<Range>(30);
  const [category, setCategory] = useState("all");
  const [sender, setSender] = useState("all");

  const a = useMemo(
    () =>
      leads.data && assignments.data
        ? buildAnalytics(leads.data as AnalyticsLead[], assignments.data, categories.data ?? [], {
            range,
            category,
            sender,
          })
        : null,
    [leads.data, assignments.data, categories.data, range, category, sender],
  );

  const failed = leads.isError || assignments.isError;
  const dailyCapacity = (senders.data ?? [])
    .filter((s) => s.active && (sender === "all" || s.id === sender))
    .reduce((sum, s) => sum + s.daily_limit, 0);
  const hasUncategorized = (leads.data ?? []).some((l) => l.category_id === null);

  return (
    <AppShell {...(a && a.messaged ? { badge: `نسبة الرد ${pct(a.replied, a.messaged)}` } : {})}>
      {/* One filter row above everything it scopes */}
      <div className="rise mt-6 flex flex-wrap items-center gap-2">
        <div className="glass inline-flex flex-wrap gap-1 rounded-xl p-1" role="group" aria-label="الفترة">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              aria-pressed={range === r.value}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="الفئة"
          className="glass rounded-xl px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
        >
          <option value="all">كل الفئات</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {hasUncategorized ? <option value="none">بدون فئة</option> : null}
        </select>
        {(senders.data ?? []).length > 1 ? (
          <select
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            aria-label="رقم الإرسال"
            className="glass rounded-xl px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
          >
            <option value="all">كل الأرقام</option>
            {(senders.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.phone}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {failed ? (
        <div className="glass mt-4 rounded-2xl p-8 text-center text-sm text-accent">تعذّر تحميل البيانات — جرّب تحدّث الصفحة.</div>
      ) : !a ? (
        <div className="glass mt-4 rounded-2xl p-8 text-center text-sm text-muted-foreground">بيحمّل التحليلات…</div>
      ) : (
        <div className={`mt-4 space-y-4 transition-opacity ${leads.isFetching ? "opacity-70" : ""}`}>
          {/* Headline: the response rate, then the counts behind it */}
          <section className="rise grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="glass col-span-2 rounded-2xl p-5 lg:row-span-2">
              <div className="text-sm text-muted-foreground">نسبة الرد</div>
              <div className="mt-2 text-6xl font-semibold leading-none text-foreground">
                {a.rate === null ? "—" : pct(a.replied, a.messaged)}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {a.messaged ? (
                  <>
                    <span className="font-semibold text-foreground">{n(a.replied)}</span> عيادة ردّت من{" "}
                    <span className="font-semibold text-foreground">{n(a.messaged)}</span> اتبعتلها
                    {range ? ` في ${RANGES.find((r) => r.value === range)?.label}` : ""}
                  </>
                ) : (
                  "مفيش عيادات اتبعتلها في الفترة دي"
                )}
              </p>
              {a.legacyReplied > 0 ? (
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  منهم {n(a.legacyReplied)} ردّوا قبل ما البوت يفرّق بين الرد الحقيقي والرد الآلي، فممكن يكون فيهم ردود آلية.
                </p>
              ) : null}
            </div>
            <Tile label="اتبعتلهم" value={n(a.messaged)} />
            <Tile label="ردّوا" value={n(a.replied)} />
            <Tile label="محتاجين تكمّل معاهم" value={n(a.hot)} hint="حالتهم «متابعة» أو «مهتم»" />
            <Tile label="مستنيين رد" value={n(a.waiting)} />
          </section>

          <section className="rise grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="وقت الرد (الوسيط)"
              value={formatMinutes(a.medianReplyMinutes)}
              hint={a.replyTimes ? `من ${n(a.replyTimes)} رد اتسجّل وقته` : "بيتحسب من الردود اللي البوت بيسجّل وقتها"}
            />
            <Tile label="غير مهتم" value={n(a.notInterested)} />
            <Tile
              label="لسه ما اتبعتلهمش"
              value={n(a.notYet)}
              hint={dailyCapacity ? `يكفّوا حوالي ${n(Math.ceil(a.notYet / dailyCapacity))} يوم بمعدل ${n(dailyCapacity)} في اليوم` : undefined}
            />
            <Tile label="بدون واتساب" value={n(a.noWhatsapp)} />
          </section>

          <DailyChart rows={a.days} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="من كل اللي اتبعتلهم" subtitle="كل نسبة من عدد العيادات اللي اتبعتلها">
              <MeterList
                rows={[
                  { key: "replied", label: "ردّوا", messaged: a.messaged, replied: a.replied },
                  { key: "hot", label: "محتاجين تكمّل معاهم", messaged: a.messaged, replied: a.hot },
                  { key: "no", label: "غير مهتم", messaged: a.messaged, replied: a.notInterested },
                  { key: "wait", label: "مستنيين رد", messaged: a.messaged, replied: a.waiting },
                ]}
              />
            </Card>
            <Card title="نسبة الرد حسب وقت التحية" subtitle="مين بيرد أكتر: التحية اللي اتبعتت الصبح ولا بالليل">
              <MeterList rows={a.windows} />
            </Card>
            <Card title="نسبة الرد حسب الفئة">
              <MeterList rows={a.byCategory} />
            </Card>
            <Card title="نسبة الرد حسب المدينة" subtitle="المدن اللي اتبعتلها أكتر">
              <MeterList rows={a.byCity} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="سرعة الرد"
              subtitle={`من وقت التحية لأول رد حقيقي — من ${n(a.replyTimes)} رد اتسجّل وقته`}
            >
              <MeterList rows={a.replySpeed} />
            </Card>
            <Card title="رسالة المتابعة" subtitle="«مساء الخير بس أتأكد إن رسالتي وصلت» — للي ما ردّوش على التحية 24 ساعة">
              <MeterList
                rows={[{ key: "fu", label: "ردّوا بعد المتابعة", messaged: a.followUps.sent, replied: a.followUps.replied }]}
              />
            </Card>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/* ---------- pieces ---------- */

function Tile({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rise glass rounded-2xl p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-6 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <div>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One ratio per row against its own whole: name, an aligned bar, the share and "x من y". */
function MeterList({ rows }: { rows: Row[] }) {
  if (rows.length === 0 || rows.every((r) => r.messaged === 0))
    return <p className="py-4 text-center text-sm text-muted-foreground">مفيش بيانات في الفترة دي.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const share = r.messaged ? r.replied / r.messaged : 0;
        return (
          <li
            key={r.key}
            className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,11rem)_1fr_auto]"
          >
            <span className="truncate text-sm text-foreground" title={r.label}>
              {r.label}
            </span>
            <div
              className="order-last col-span-2 h-2 rounded-full sm:order-none sm:col-span-1"
              style={{ background: `${TEAL}26` }}
              role="img"
              aria-label={`${r.label}: ${pct(r.replied, r.messaged)}`}
            >
              <div className="h-2 rounded-full" style={{ width: `${share * 100}%`, background: TEAL }} />
            </div>
            <span className="text-left text-sm whitespace-nowrap">
              <span className="font-semibold text-foreground">{pct(r.replied, r.messaged)}</span>{" "}
              <span className="num text-xs text-muted-foreground">
                {n(r.replied)} من {n(r.messaged)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Clinics first written to each day, and how many of that day's clinics answered. */
function DailyChart({ rows }: { rows: Row[] }) {
  const [asTable, setAsTable] = useState(false);
  const data = rows.map((r) => ({ ...r, day: dayLabel(r.key) }));
  const toggle = (
    <button
      onClick={() => setAsTable(!asTable)}
      className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground"
    >
      {asTable ? "عرض كرسم" : "عرض كجدول"}
    </button>
  );
  return (
    <Card
      title="يوم بيوم"
      subtitle="العيادات اللي اتبعتلها كل يوم، وكام واحدة منهم ردّت (لحد دلوقتي)"
      action={toggle}
    >
      <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
        <LegendKey color={TEAL} label="اتبعتلهم" />
        <LegendKey color={ORANGE} label="ردّوا" />
      </div>
      {asTable ? (
        <div className="max-h-80 overflow-auto rounded-xl ring-1 ring-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-right font-medium">اليوم</th>
                <th className="px-3 py-2 text-right font-medium">اتبعتلهم</th>
                <th className="px-3 py-2 text-right font-medium">ردّوا</th>
                <th className="px-3 py-2 text-right font-medium">النسبة</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="px-3 py-2">{fullDay(r.key)}</td>
                  <td className="num px-3 py-2">{n(r.messaged)}</td>
                  <td className="num px-3 py-2">{n(r.replied)}</td>
                  <td className="num px-3 py-2">{pct(r.replied, r.messaged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // LTR box with a reversed axis: the days run right to left, like the page
        <div dir="ltr" className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="day"
                reversed
                tickLine={false}
                axisLine={{ stroke: GRID }}
                tick={{ fill: AXIS, fontSize: 11 }}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis
                orientation="right"
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                width={32}
                tick={{ fill: AXIS, fontSize: 11 }}
              />
              <Tooltip cursor={{ fill: "rgba(27, 46, 42, 0.05)" }} content={<DayTooltip />} />
              {/* Drawn left to right, so «ردّوا» first puts «اتبعتلهم» on the right, read first */}
              <Bar dataKey="replied" name="ردّوا" fill={ORANGE} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
              <Bar dataKey="messaged" name="اتبعتلهم" fill={TEAL} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

function DayTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div dir="rtl" className="rounded-xl bg-popover px-3 py-2 text-xs shadow-lg ring-1 ring-border">
      <div className="mb-1.5 text-muted-foreground">{fullDay(row.key)}</div>
      {[
        { color: TEAL, label: "اتبعتلهم", value: row.messaged },
        { color: ORANGE, label: "ردّوا", value: row.replied },
      ].map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="text-sm font-semibold text-foreground">{n(s.value)}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </div>
      ))}
      <div className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">
        نسبة الرد <span className="font-semibold text-foreground">{pct(row.replied, row.messaged)}</span>
      </div>
    </div>
  );
}
