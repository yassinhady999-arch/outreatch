// Decision rules for the bot, kept free of WhatsApp/database calls so they can be tested directly.
// normalizePhone / whatsappNumber / GREETING mirror src/lib/leads.ts: the bot runs as plain
// Node, outside the app bundle, so it can't import that file.

/** The opening line, the same one the «التحية» button sends. */
export const GREETING = "السلام عليكم و رحمة الله و بركاته";

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII. */
const toAsciiDigits = (s) =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Keeps only digits and a leading "+". */
export function normalizePhone(raw) {
  const cleaned = toAsciiDigits(String(raw)).replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\+/g, "");
  if (cleaned.startsWith("+")) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  return digits;
}

/** Country code + number, digits only (what WhatsApp uses). */
export function whatsappNumber(phone) {
  const p = normalizePhone(phone);
  if (p.startsWith("+")) return p.slice(1);
  // Egyptian mobile in local form; other local formats are ambiguous
  if (/^01\d{9}$/.test(p)) return "20" + p.slice(1);
  return p;
}

export const phoneToJid = (phone) => `${whatsappNumber(phone)}@s.whatsapp.net`;

/** The ways a lead's phone may be saved, for a WhatsApp user id (digits@s.whatsapp.net). */
export function phoneCandidates(jid) {
  const digits = String(jid).split("@")[0].split(":")[0];
  const list = [`+${digits}`, digits];
  if (/^201\d{9}$/.test(digits)) list.push(`0${digits.slice(2)}`); // Egyptian local form
  return list;
}

/** Local calendar date as YYYY-MM-DD, like the app's todayISO(). */
export const toISODate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Inside the sending hours on the local clock, e.g. from 9 (inclusive) to 21 (exclusive). */
export const withinHours = (date, from, to) => date.getHours() >= from && date.getHours() < to;

/**
 * Today's assignments of one sender that still need the greeting, oldest first: not sent,
 * not greeted yet, still waiting ('assigned') and not marked "no WhatsApp".
 */
export function waitingForGreeting(assignments) {
  return assignments
    .filter(
      (a) =>
        !a.sent &&
        a.leads &&
        !a.leads.greeted_at &&
        a.leads.status === "assigned" &&
        !a.leads.no_whatsapp,
    )
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * What to do when someone writes in. The clinic's own message goes out once: only to a lead
 * that got the greeting and whose assignment isn't marked sent yet.
 */
export function replyAction(lead, assignment) {
  if (!lead || !lead.greeted_at) return "ignore"; // not one of ours, or never greeted
  if (!assignment || assignment.sent) return "ignore"; // message already went out
  if (!lead.message || !lead.message.trim()) return "no-message";
  return "send-message";
}

export const randomBetween = (min, max) => min + Math.random() * (max - min);

/**
 * The clinic's message without its opening salam line (and the blank lines after it): the
 * greeting already said «السلام عليكم». Mirrors withoutSalam() in src/lib/leads.ts.
 */
export const withoutSalam = (message) =>
  String(message ?? "")
    .replace(/^\s*السلام عليكم[^\n]*\n+/, "")
    .trim();

/** 5 greetings 9–12, 5 in 12–15, 5 in 15–19, 5 in 19–21 (hours on this computer's clock). */
export const DEFAULT_SCHEDULE = "9-12:5,12-15:5,15-19:5,19-21:5";

/** "9-12:5,12-15:5" → [{ from: 9, to: 12, count: 5 }, …], earliest first. */
export function parseSchedule(text) {
  return String(text)
    .split(",")
    .map((part) => {
      const m = part.trim().match(/^(\d{1,2})-(\d{1,2}):(\d+)$/);
      if (!m) throw new Error(`جدول الإرسال غلط عند "${part}" — المفروض زي 9-12:5`);
      return { from: Number(m[1]), to: Number(m[2]), count: Number(m[3]) };
    })
    .sort((a, b) => a.from - b.from);
}

const atHour = (day, hour) => {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/**
 * When the next greeting may go out. Each window sends at most its count, greetings are at
 * least `gapMinutes` apart, and nothing goes out between windows. `assignments` are today's
 * assignments of this sender (sent or not), with their leads.
 * Returns { send: assignment } or { waitUntil: Date, reason }.
 */
export function planNextGreeting(now, schedule, assignments, gapMinutes) {
  const hour = now.getHours();
  const win = schedule.find((w) => hour >= w.from && hour < w.to);
  if (!win) {
    const later = schedule.find((w) => w.from > hour);
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    return {
      waitUntil: later ? atHour(now, later.from) : atHour(tomorrow, schedule[0].from),
      reason: "outside",
    };
  }

  const today = toISODate(now);
  const greetedToday = assignments
    .map((a) => (a.leads?.greeted_at ? new Date(a.leads.greeted_at) : null))
    .filter((d) => d && toISODate(d) === today);
  const start = atHour(now, win.from);
  const end = atHour(now, win.to);
  if (greetedToday.filter((d) => d >= start && d < end).length >= win.count) {
    return { waitUntil: end, reason: "window-full" };
  }

  const last = greetedToday.reduce((max, d) => (!max || d > max ? d : max), null);
  if (last) {
    const ready = new Date(last.getTime() + gapMinutes * 60_000);
    if (ready > now) return { waitUntil: ready, reason: "gap" };
  }

  const [next] = waitingForGreeting(assignments);
  if (!next) return { waitUntil: new Date(now.getTime() + 10 * 60_000), reason: "none-left" };
  return { send: next };
}
