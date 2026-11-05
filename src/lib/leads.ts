import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type LeadStatus = Database["public"]["Enums"]["lead_status"];
export type Lead = Database["public"]["Tables"]["leads"]["Row"];
export type Sender = Database["public"]["Tables"]["senders"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];
export type Category = Database["public"]["Tables"]["categories"]["Row"];

export const STATUS_ORDER: LeadStatus[] = [
  "new",
  "assigned",
  "contacted",
  "replied",
  "interested",
  "not_interested",
  "follow_up",
  "closed",
];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "جديد",
  assigned: "مُسند",
  contacted: "تم التواصل",
  replied: "ردّ",
  interested: "مهتم",
  not_interested: "غير مهتم",
  follow_up: "متابعة",
  closed: "مغلق",
};

export const STATUS_TONE: Record<LeadStatus, string> = {
  new: "bg-neutral-chip text-neutral-chip-foreground",
  assigned: "bg-primary/10 text-primary",
  contacted: "bg-info text-info-foreground",
  replied: "bg-info text-info-foreground",
  interested: "bg-success text-success-foreground",
  not_interested: "bg-neutral-chip text-neutral-chip-foreground",
  follow_up: "bg-warning text-warning-foreground",
  closed: "bg-neutral-chip text-neutral-chip-foreground",
};

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII. */
const toAsciiDigits = (s: string) =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Keeps only digits and a leading "+" (drops spaces, dashes, dots, invisible bidi marks). */
export function normalizePhone(raw: string) {
  const cleaned = toAsciiDigits(raw).replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\+/g, "");
  if (cleaned.startsWith("+")) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  return digits;
}

/** Digits in the form WhatsApp links expect: country code + number, no "+". */
export function whatsappNumber(phone: string) {
  const p = normalizePhone(phone);
  if (p.startsWith("+")) return p.slice(1);
  // Egyptian mobile in local form; other local formats are ambiguous (05… is both KSA and UAE)
  if (/^01\d{9}$/.test(p)) return "20" + p.slice(1);
  return p;
}

/** What follows the country code on a mobile number; anything else is a landline/unified/toll-free line. */
const MOBILE_AFTER_CODE: Record<string, RegExp> = {
  "+966": /^5/, // Saudi: 05… mobile; 01x landline, 920 unified, 800 toll-free
  "+971": /^5/, // UAE
  "+965": /^[569]/, // Kuwait
  "+974": /^[3567]/, // Qatar
  "+973": /^[36]/, // Bahrain
  "+968": /^[79]/, // Oman
  "+962": /^7/, // Jordan
  "+20": /^1/, // Egypt
};

/**
 * true = mobile, false = landline / unified (920) / toll-free (800), which almost never have
 * WhatsApp, null = country not covered or no country code, so no guess is made.
 */
export function isMobileNumber(phone: string): boolean | null {
  const p = normalizePhone(phone);
  const code = Object.keys(MOBILE_AFTER_CODE).find((c) => p.startsWith(c));
  return code ? (MOBILE_AFTER_CODE[code]?.test(p.slice(code.length)) ?? null) : null;
}

/** A clickable link from "@handle", "instagram.com/handle" or a full URL. */
export function instagramUrl(value: string) {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("@")) return `https://instagram.com/${v.slice(1)}`;
  return `https://${v}`;
}

export function countryFromPhone(phone: string) {
  const map: Record<string, string> = {
    "+966": "السعودية",
    "+971": "الإمارات",
    "+965": "الكويت",
    "+974": "قطر",
    "+973": "البحرين",
    "+968": "عُمان",
    "+20": "مصر",
    "+962": "الأردن",
  };
  const hit = Object.keys(map).find((code) => phone.startsWith(code));
  return hit ? (map[hit] ?? "") : "";
}

/** Local calendar date as YYYY-MM-DD (not UTC). */
export const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayISO = () => toISODate(new Date());

export function formatArabicDate(date = new Date()) {
  return new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long" }).format(date);
}

/* ---------- queries ---------- */

export async function fetchSenders() {
  const { data, error } = await supabase
    .from("senders")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

/** The API returns at most this many rows per request, so bigger lists are fetched in pages. */
const PAGE = 1000;

/** All of the user's leads, newest first. */
export async function fetchLeads() {
  const all: Lead[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

/* ---------- categories ---------- */

/** Per-category counts from category_stats(); category_id null = uncategorized. */
export type CategoryStats = {
  category_id: string | null;
  total: number;
  /** not distributed yet */
  waiting: number;
  /** distributed, not sent yet */
  pending: number;
  sent: number;
  no_whatsapp: number;
};

export async function fetchCategories() {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function fetchCategoryStats() {
  const { data, error } = await supabase.rpc("category_stats");
  if (error) throw error;
  return (data ?? []) as unknown as CategoryStats[];
}

export async function addCategory(name: string) {
  const { error } = await supabase.from("categories").insert({ name: name.trim() });
  if (error) {
    if (error.code === "23505") throw new Error("DUPLICATE");
    throw error;
  }
}

/** Turning a category off frees its unsent leads; turning it on lets them back into the queue. */
export async function updateCategory(id: string, patch: { name?: string; active?: boolean }) {
  const { error } = await supabase.from("categories").update(patch).eq("id", id);
  if (error) {
    if (error.code === "23505") throw new Error("DUPLICATE");
    throw error;
  }
  await distributeLeads().catch(() => 0);
}

/** The category's leads stay, uncategorized (and so distributable again). */
export async function deleteCategory(id: string) {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw error;
  await distributeLeads().catch(() => 0);
}

export type TodayAssignment = Assignment & { leads: Lead | null };

/** Still waiting to be sent — rolls over to the next day. Mirrors distribute_leads(). */
export const isPending = (a: TodayAssignment) =>
  !a.sent && a.leads?.status === "assigned" && !a.leads.no_whatsapp;

/** Everything except unsent no-WhatsApp leads uses up the sender's daily limit. */
export const usesCapacity = (a: TodayAssignment) => a.sent || !a.leads?.no_whatsapp;

export async function fetchTodayAssignments(date?: string) {
  const { data, error } = await supabase
    .from("assignments")
    .select("*, leads(*)")
    .eq("assign_date", date ?? todayISO())
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TodayAssignment[];
}

export async function addLead(input: {
  phone: string;
  name: string;
  country: string;
  categoryId: string | null;
}) {
  const phone = normalizePhone(input.phone);
  // Landline / unified / toll-free numbers start out as "no WhatsApp" (can be undone)
  const noWhatsapp = isMobileNumber(phone) === false;
  const { error } = await supabase.from("leads").insert({
    phone,
    name: input.name.trim() || null,
    country: input.country || countryFromPhone(phone) || null,
    no_whatsapp: noWhatsapp,
    // Only sent when set, so adding still works on a database without categories yet
    ...(input.categoryId ? { category_id: input.categoryId } : {}),
  });
  if (error) {
    if (error.code === "23505" || error.code === "23514" || /duplicate/i.test(error.message)) {
      throw new Error("DUPLICATE");
    }
    throw error;
  }
  await distributeLeads().catch(() => 0);
  return { noWhatsapp };
}

export type LeadImportRow = { phone: string; name: string; instagram: string; message: string };

type SavedLead = Pick<Lead, "id" | "phone" | "name" | "instagram" | "message">;
type LeadPatch = { message?: string; name?: string; instagram?: string };

/**
 * For numbers that were already saved: the file's message wins (it's the newest version),
 * and a missing name / Instagram gets filled in. Nothing else (category, status, WhatsApp
 * flag) is touched. Returns only the leads that actually change.
 */
export function enrichmentPatches(saved: SavedLead[], rows: LeadImportRow[]) {
  const byPhone = new Map(rows.map((r) => [normalizePhone(r.phone), r]));
  return saved.flatMap((lead) => {
    const row = byPhone.get(lead.phone);
    if (!row) return [];
    const patch: LeadPatch = {};
    const message = row.message.trim();
    if (message && message !== lead.message) patch.message = message;
    if (!lead.name && row.name.trim()) patch.name = row.name.trim();
    if (!lead.instagram && row.instagram.trim()) patch.instagram = row.instagram.trim();
    return Object.keys(patch).length > 0 ? [{ id: lead.id, patch }] : [];
  });
}

export async function addLeadsBulk(rows: LeadImportRow[], categoryId: string | null) {
  const cleaned = rows
    .map((r) => ({ ...r, phone: normalizePhone(r.phone) }))
    .filter((r) => r.phone.length >= 6);
  const unique = [...new Map(cleaned.map((r) => [r.phone, r])).values()];

  // Numbers already saved (in any category) are skipped by the database itself
  // (ON CONFLICT DO NOTHING on the user/phone key), so this holds for any list size
  let added = 0;
  let flagged = 0;
  const insertedPhones = new Set<string>();
  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await supabase
      .from("leads")
      .upsert(
        unique.slice(i, i + 500).map((r) => ({
          phone: r.phone,
          name: r.name.trim() || null,
          instagram: r.instagram.trim() || null,
          country: countryFromPhone(r.phone) || null,
          // Landline / unified / toll-free numbers start out as "no WhatsApp" (can be undone)
          no_whatsapp: isMobileNumber(r.phone) === false,
          ...(categoryId ? { category_id: categoryId } : {}),
          ...(r.message.trim() ? { message: r.message.trim() } : {}),
        })),
        { onConflict: "user_id,phone", ignoreDuplicates: true },
      )
      .select("id, phone, no_whatsapp");
    // PGRST204: a column (message / category_id) the database doesn't have yet
    if (error) throw error.code === "PGRST204" ? new Error("MIGRATION") : error;
    added += data.length;
    flagged += data.filter((l) => l.no_whatsapp).length;
    data.forEach((l) => insertedPhones.add(l.phone));
  }

  // Numbers that already existed: bring in the file's message / missing details, so
  // re-importing a corrected file (e.g. one with messages) updates them instead of skipping
  let updated = 0;
  const existing = unique.filter((r) => !insertedPhones.has(r.phone));
  for (let i = 0; i < existing.length; i += 200) {
    const chunk = existing.slice(i, i + 200);
    const { data: saved, error } = await supabase
      .from("leads")
      .select("id, phone, name, instagram, message")
      .in(
        "phone",
        chunk.map((r) => r.phone),
      );
    if (error) throw error.code === "42703" ? new Error("MIGRATION") : error;
    const patches = enrichmentPatches(saved, chunk);
    // A few at a time to stay gentle on the API
    for (let j = 0; j < patches.length; j += 10) {
      const results = await Promise.all(
        patches
          .slice(j, j + 10)
          .map(({ id, patch }) => supabase.from("leads").update(patch).eq("id", id)),
      );
      const failed = results.find((r) => r.error)?.error;
      if (failed) throw failed;
      updated += results.length;
    }
  }

  if (added > 0) await distributeLeads().catch(() => 0);
  return {
    added,
    /** of the added numbers, how many were marked "no WhatsApp" as non-mobile */
    flagged,
    /** numbers that already existed and got the file's message / missing details */
    updated,
    skipped: unique.length - added - updated,
    invalid: rows.length - cleaned.length,
  };
}

export async function addSender(input: { phone: string; label: string; daily_limit: number }) {
  const { error } = await supabase.from("senders").insert({
    phone: normalizePhone(input.phone),
    label: input.label.trim() || null,
    daily_limit: input.daily_limit,
  });
  if (error) {
    if (/duplicate/i.test(error.message)) throw new Error("DUPLICATE");
    throw error;
  }
  await distributeLeads().catch(() => 0);
}

export async function updateSender(id: string, patch: Partial<Sender>) {
  const { error } = await supabase.from("senders").update(patch).eq("id", id);
  if (error) throw error;
  await distributeLeads().catch(() => 0);
}

export async function deleteSender(id: string) {
  const { error } = await supabase.from("senders").delete().eq("id", id);
  if (error) throw error;
  await distributeLeads().catch(() => 0);
}

export async function deleteLead(id: string) {
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) throw error;
}

export async function setLeadStatus(id: string, status: LeadStatus) {
  const { error } = await supabase.from("leads").update({ status }).eq("id", id);
  if (error) throw error;
  await distributeLeads().catch(() => 0);
}

export async function setLeadNoWhatsapp(id: string, noWhatsapp: boolean) {
  const { error } = await supabase.from("leads").update({ no_whatsapp: noWhatsapp }).eq("id", id);
  if (error) throw error;
  await distributeLeads().catch(() => 0);
}

export async function markSent(assignmentId: string, sent: boolean) {
  const { error } = await supabase
    .from("assignments")
    .update({ sent, sent_at: sent ? new Date().toISOString() : null })
    .eq("id", assignmentId);
  if (error) throw error;
}

export type ForecastRow = {
  sender_id: string;
  lead_id: string;
  phone: string;
  name: string | null;
  instagram: string | null;
  category_id: string | null;
};
export type Forecast = { queued: number; capacity: number; rows: ForecastRow[] };

/**
 * Leads each sender will get on a future `date`, assuming every earlier day's batch is sent
 * (see forecast_leads()). Unsent leads roll over, so a skipped day pushes the whole plan back.
 */
export async function fetchForecast(date: string) {
  const { data, error } = await supabase.rpc("forecast_leads", {
    p_today: todayISO(),
    p_date: date,
  });
  if (error) throw error;
  return data as unknown as Forecast;
}

/** `today` is the browser's local date so the DB and the UI agree on what "today" is. */
/** The opening line sent before the clinic's own message. */
export const GREETING = "السلام عليكم و رحمة الله و بركاته";

/** Records that the greeting went out, shown as a mark on the client's card. */
export async function markGreeted(leadId: string) {
  const { error } = await supabase
    .from("leads")
    .update({ greeted_at: new Date().toISOString() })
    .eq("id", leadId);
  // PGRST204: the greeted_at column isn't in the database yet (migration 0006)
  if (error) throw error.code === "PGRST204" ? new Error("MIGRATION") : error;
}

/** Marks the lead's unsent assignment as sent; a no-op if it has none (not distributed yet). */
export async function markLeadSent(leadId: string) {
  const { error } = await supabase
    .from("assignments")
    .update({ sent: true, sent_at: new Date().toISOString() })
    .eq("lead_id", leadId)
    .eq("sent", false);
  if (error) throw error;
}

export async function distributeLeads(today = todayISO()) {
  const { data, error } = await supabase.rpc("distribute_leads", { p_today: today });
  if (error) throw error;
  return (data ?? 0) as number;
}
