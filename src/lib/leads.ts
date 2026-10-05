import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type LeadStatus = Database["public"]["Enums"]["lead_status"];
export type Lead = Database["public"]["Tables"]["leads"]["Row"];
export type Sender = Database["public"]["Tables"]["senders"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];

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

export async function fetchLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
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

export async function addLead(input: { phone: string; name: string; country: string }) {
  const phone = normalizePhone(input.phone);
  const { error } = await supabase.from("leads").insert({
    phone,
    name: input.name.trim() || null,
    country: input.country || countryFromPhone(phone) || null,
  });
  if (error) {
    if (error.code === "23505" || error.code === "23514" || /duplicate/i.test(error.message)) {
      throw new Error("DUPLICATE");
    }
    throw error;
  }
  await distributeLeads().catch(() => 0);
}

export type LeadImportRow = { phone: string; name: string; instagram: string };

export async function addLeadsBulk(rows: LeadImportRow[]) {
  const cleaned = rows
    .map((r) => ({ ...r, phone: normalizePhone(r.phone) }))
    .filter((r) => r.phone.length >= 6);
  const unique = [...new Map(cleaned.map((r) => [r.phone, r])).values()];

  const { data: existing, error: fetchErr } = await supabase.from("leads").select("phone");
  if (fetchErr) throw fetchErr;
  const existingSet = new Set((existing ?? []).map((l) => l.phone));

  const fresh = unique.filter((r) => !existingSet.has(r.phone));
  if (fresh.length > 0) {
    const { error } = await supabase.from("leads").insert(
      fresh.map((r) => ({
        phone: r.phone,
        name: r.name.trim() || null,
        instagram: r.instagram.trim() || null,
        country: countryFromPhone(r.phone) || null,
      })),
    );
    if (error) throw error;
    await distributeLeads().catch(() => 0);
  }
  return { added: fresh.length, skipped: unique.length - fresh.length, invalid: rows.length - cleaned.length };
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
