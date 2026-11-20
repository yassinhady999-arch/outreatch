import { supabase } from "@/integrations/supabase/client";
import { toISODate, type Category, type Lead } from "@/lib/leads";

/** The slice of an assignment the analytics need. */
export type AssignmentLite = {
  lead_id: string;
  sender_id: string | null;
  sent: boolean;
  sent_at: string | null;
  assign_date: string;
};

/** A lead as the page reads it; replied_at exists once migration 0010 ran. */
export type AnalyticsLead = Lead & { replied_at?: string | null };

const PAGE = 1000;

/** Every assignment (paged: the API returns at most 1000 rows per request). */
export async function fetchAssignmentsLite() {
  const all: AssignmentLite[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("assignments")
      .select("lead_id, sender_id, sent, sent_at, assign_date")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

/** `step` of a clinic you're handling yourself (bot/core.mjs TAKEN_OVER). */
const TAKEN_OVER = 99;
/** Statuses only reached after the clinic answered. */
const ANSWERED = new Set(["replied", "follow_up", "interested", "not_interested", "closed"]);
/** The clinic is talking with you: the bot handed it over, or you marked it. */
const HOT = new Set(["follow_up", "interested", "closed"]);

/** The clinic answered for real (the bot records it; older ones are known from their status). */
export function hasReplied(l: AnalyticsLead) {
  return (
    Boolean(l.replied_at) ||
    ANSWERED.has(l.status) ||
    // the bot's 2-message version marked a real reply «تم التواصل» and moved to step 1
    (l.status === "contacted" && (l.step ?? 0) >= 1 && (l.step ?? 0) < TAKEN_OVER)
  );
}

/** When the clinic was first written to: the greeting, else the message marked «اتبعت». */
export function messagedAt(l: AnalyticsLead, a: AssignmentLite | undefined): Date | null {
  if (l.greeted_at) return new Date(l.greeted_at);
  if (a?.sent) return new Date(a.sent_at ?? `${a.assign_date}T12:00:00`);
  return null;
}

/** The bot's greeting windows (bot SCHEDULE), plus greetings sent at other hours by hand. */
export const WINDOWS = [
  { key: "9-12", label: "9 الصبح – 12 الضهر", from: 9, to: 12 },
  { key: "12-15", label: "12 – 3 العصر", from: 12, to: 15 },
  { key: "15-19", label: "3 – 7 بالليل", from: 15, to: 19 },
  { key: "19-21", label: "7 – 9 بالليل", from: 19, to: 21 },
] as const;

export type Range = 7 | 30 | 90 | 0; // days back; 0 = everything
export type Filters = { range: Range; category: string; sender: string };

export type Row = { key: string; label: string; messaged: number; replied: number };

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const bump = (map: Map<string, Row>, key: string, label: string, replied: boolean) => {
  const row = map.get(key) ?? { key, label, messaged: 0, replied: 0 };
  row.messaged += 1;
  if (replied) row.replied += 1;
  map.set(key, row);
};

/**
 * Everything the analytics page shows, for one filter choice. Category and sender narrow
 * the clinics; the range keeps the ones first written to within the last N days.
 */
export function buildAnalytics(
  leads: AnalyticsLead[],
  assignments: AssignmentLite[],
  categories: Pick<Category, "id" | "name">[],
  filters: Filters,
  now = new Date(),
) {
  const byLead = new Map(assignments.map((a) => [a.lead_id, a]));
  const inCategory = (l: AnalyticsLead) =>
    filters.category === "all" ||
    (filters.category === "none" ? l.category_id === null : l.category_id === filters.category);
  const scoped = leads.filter(
    (l) => inCategory(l) && (filters.sender === "all" || byLead.get(l.id)?.sender_id === filters.sender),
  );

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (filters.range) start.setDate(start.getDate() - (filters.range - 1));

  const messaged = scoped
    .map((l) => ({ lead: l, at: messagedAt(l, byLead.get(l.id)) }))
    .filter((m): m is { lead: AnalyticsLead; at: Date } => m.at !== null)
    .filter((m) => !filters.range || m.at >= start);

  const replied = messaged.filter((m) => hasReplied(m.lead));
  const hot = messaged.filter((m) => HOT.has(m.lead.status));
  const notInterested = messaged.filter((m) => m.lead.status === "not_interested");
  const waiting = messaged.filter((m) => !hasReplied(m.lead));

  // Minutes from the greeting to the first real reply (only where both are known)
  const replyMinutes = replied
    .filter((m) => m.lead.replied_at && m.lead.greeted_at)
    .map((m) => (+new Date(m.lead.replied_at!) - +new Date(m.lead.greeted_at!)) / 60_000)
    .filter((x) => x >= 0);

  // Day by day: clinics first written to that day, and how many of them answered
  const days = new Map<string, Row>();
  const first = filters.range ? start : messaged.reduce<Date | null>((d, m) => (!d || m.at < d ? m.at : d), null);
  if (first) {
    const d = new Date(first);
    d.setHours(0, 0, 0, 0); // whole days, so today is always included
    for (; d <= now; d.setDate(d.getDate() + 1)) {
      const key = toISODate(d);
      days.set(key, { key, label: key, messaged: 0, replied: 0 });
    }
  }
  messaged.forEach((m) => {
    const row = days.get(toISODate(m.at));
    if (!row) return;
    row.messaged += 1;
    if (hasReplied(m.lead)) row.replied += 1;
  });

  // By the hour the greeting went out
  const windows = new Map<string, Row>(WINDOWS.map((w) => [w.key, { key: w.key, label: w.label, messaged: 0, replied: 0 }]));
  messaged.forEach((m) => {
    if (!m.lead.greeted_at) return;
    const h = new Date(m.lead.greeted_at).getHours();
    const w = WINDOWS.find((x) => h >= x.from && h < x.to);
    if (w) bump(windows, w.key, w.label, hasReplied(m.lead));
    else bump(windows, "other", "برّه المواعيد (بإيدك)", hasReplied(m.lead));
  });

  const names = new Map(categories.map((c) => [c.id, c.name]));
  const byCategory = new Map<string, Row>();
  messaged.forEach((m) => {
    const id = m.lead.category_id;
    bump(byCategory, id ?? "none", id ? (names.get(id) ?? "فئة محذوفة") : "بدون فئة", hasReplied(m.lead));
  });

  // Top cities by clinics written to; the rest folded into «باقي المدن»
  const byCityAll = new Map<string, Row>();
  messaged.forEach((m) => {
    const city = m.lead.city?.trim() || "بدون مدينة";
    bump(byCityAll, city, city, hasReplied(m.lead));
  });
  const cities = [...byCityAll.values()].sort((a, b) => b.messaged - a.messaged);
  const byCity = cities.slice(0, 7);
  if (cities.length > 7) {
    byCity.push(
      cities.slice(7).reduce((o, r) => ({ ...o, messaged: o.messaged + r.messaged, replied: o.replied + r.replied }), {
        key: "rest",
        label: `باقي المدن (${cities.length - 7})`,
        messaged: 0,
        replied: 0,
      }),
    );
  }

  const followedUp = messaged.filter((m) => m.lead.followed_up_at);

  return {
    messaged: messaged.length,
    replied: replied.length,
    rate: messaged.length ? replied.length / messaged.length : null,
    hot: hot.length,
    notInterested: notInterested.length,
    waiting: waiting.length,
    /** answered under the bot's first version, which also counted auto-replies */
    legacyReplied: replied.filter((m) => m.lead.status === "replied" && m.lead.step === 3).length,
    medianReplyMinutes: median(replyMinutes),
    replyTimes: replyMinutes.length,
    followUps: { sent: followedUp.length, replied: followedUp.filter((m) => hasReplied(m.lead)).length },
    /** clinics in scope not written to yet, and those flagged «بدون واتساب» */
    notYet: scoped.filter((l) => !messagedAt(l, byLead.get(l.id)) && !l.no_whatsapp).length,
    noWhatsapp: scoped.filter((l) => l.no_whatsapp).length,
    days: [...days.values()],
    windows: [...windows.values()].filter((r) => r.key !== "other" || r.messaged > 0),
    byCategory: [...byCategory.values()].sort((a, b) => b.messaged - a.messaged),
    byCity,
  };
}

export type Analytics = ReturnType<typeof buildAnalytics>;

/** "45%" (no decimals) or "—" when there's nothing to divide. */
export const pct = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : "—";

/** 95 → "1 س 35 د", 2900 → "2 يوم" */
export function formatMinutes(min: number | null) {
  if (min === null) return "—";
  if (min < 60) return `${Math.round(min)} دقيقة`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m ? `${h} س ${m} د` : `${h} ساعة`;
  }
  return `${Math.round(min / (24 * 60))} يوم`;
}
