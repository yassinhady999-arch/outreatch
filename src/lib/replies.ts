import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { normalizePhone, type Lead } from "@/lib/leads";

/**
 * The «الردود» page: the clinics that answered, with their last message, the management number
 * the bot picked out of their reply, and the whole conversation the bot keeps (table messages,
 * drizzle/migrations/0011_conversations.sql).
 */

export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type ThreadMessage = Pick<
  Message,
  "id" | "author" | "kind" | "body" | "auto" | "sent_at" | "chat_phone"
>;

const REPLY_FIELDS =
  "id, name, phone, city, status, step, category_id, greeted_at, replied_at, manager_phone, manager_phone_at, last_in_at, last_in_text, last_in_kind, last_msg_at, last_msg_author";

export type ReplyLead = Pick<
  Lead,
  | "id"
  | "name"
  | "phone"
  | "city"
  | "status"
  | "step"
  | "category_id"
  | "greeted_at"
  | "replied_at"
  | "manager_phone"
  | "manager_phone_at"
  | "last_in_at"
  | "last_in_text"
  | "last_in_kind"
  | "last_msg_at"
  | "last_msg_author"
>;

/** The page needs the SQL of 0011_conversations.sql (new columns and table). */
export class MissingSqlError extends Error {}

const missingSql = (error: { code?: string; message?: string }) =>
  error.code === "42703" ||
  error.code === "42P01" ||
  error.code === "PGRST204" ||
  error.code === "PGRST205" ||
  /manager_phone|last_in_|last_msg_|messages/.test(error.message ?? "");

/** When the clinic last moved: its last message, else when the number came, else its first reply. */
export const lastActivity = (l: ReplyLead) =>
  [l.last_in_at, l.manager_phone_at, l.replied_at].reduce<string>(
    (max, d) => (d && d > max ? d : max),
    "",
  );

const PAGE = 1000;

/** Every clinic that answered, is in «متابعة», or sent a management number — the latest first. */
export async function fetchReplyLeads(): Promise<ReplyLead[]> {
  const all: ReplyLead[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("leads")
      .select(REPLY_FIELDS)
      .or(
        "status.eq.follow_up,manager_phone.not.is.null,replied_at.not.is.null,last_in_at.not.is.null",
      )
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw missingSql(error) ? new MissingSqlError(error.message) : error;
    all.push(...(data as ReplyLead[]));
    if (data.length < PAGE) break;
  }
  return all.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
}

/** A clinic's whole conversation, oldest first (its own chat and its management number's). */
export async function fetchThread(leadId: string): Promise<ThreadMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, author, kind, body, auto, sent_at, chat_phone")
    .eq("lead_id", leadId)
    .order("sent_at")
    .limit(1000);
  if (error) throw missingSql(error) ? new MissingSqlError(error.message) : error;
  return data;
}

/**
 * A management number typed by hand: Saudi mobiles in any form (05…, 5…, 9665…), Saudi
 * landlines (01…), unified 920… numbers, Egyptian mobiles (01x…), or any number with its code
 * (+… / 00…). → "+<code><number>", "" to clear, or null when it isn't a phone number.
 */
export function parsePhoneInput(raw: string): string | null {
  const p = normalizePhone(raw.trim());
  if (!p) return "";
  if (p.startsWith("+")) return /^\+[1-9]\d{9,14}$/.test(p) ? p : null;
  if (/^05\d{8}$/.test(p)) return `+966${p.slice(1)}`;
  if (/^5\d{8}$/.test(p)) return `+966${p}`;
  if (/^01[0125]\d{8}$/.test(p)) return `+20${p.slice(1)}`;
  if (/^01\d{8}$/.test(p)) return `+966${p.slice(1)}`;
  if (/^920\d{6}$/.test(p)) return `+966${p}`;
  if (/^966\d{9}$/.test(p) || /^20\d{10}$/.test(p)) return `+${p}`;
  return null;
}

export async function setManagerPhone(id: string, phone: string | null) {
  const { error } = await supabase
    .from("leads")
    .update({
      manager_phone: phone || null,
      manager_phone_at: phone ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) throw error;
}

/** What a message without text was. */
export const KIND_LABEL: Record<string, string> = {
  image: "📷 صورة",
  video: "🎬 فيديو",
  voice: "🎤 رسالة صوتية",
  audio: "🎵 ملف صوتي",
  document: "📄 ملف",
  sticker: "ملصق",
  contact: "👤 جهة اتصال",
  location: "📍 موقع",
  reaction: "تفاعل",
  poll: "📊 تصويت",
  other: "رسالة",
};

/** The text to show for a message: its text, or what it was plus its caption. */
export function messageLabel(kind: string | null | undefined, body: string | null | undefined) {
  const text = (body ?? "").trim();
  if (!kind || kind === "text") return text;
  const label = KIND_LABEL[kind] ?? KIND_LABEL["other"];
  return text ? `${label} — ${text}` : label;
}

const relative = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat("ar-EG", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const timeOnly = new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit" });

/** «منذ 5 دقائق», «منذ ساعتين», then the date and time for anything older than a day. */
export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "الآن";
  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 24 * 60) return relative.format(-Math.round(minutes / 60), "hour");
  return dateTime.format(new Date(iso));
}

export const clockTime = (iso: string) => timeOnly.format(new Date(iso));
export const fullTime = (iso: string) => dateTime.format(new Date(iso));

/** Same number, whatever way it was written. */
export const samePhone = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && normalizePhone(a).replace(/^\+/, "") === normalizePhone(b).replace(/^\+/, "");
