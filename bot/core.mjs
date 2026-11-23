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

export const randomBetween = (min, max) => min + Math.random() * (max - min);

/* ---------- the conversation after the greeting (texts in script.mjs) ---------- */

// Messages written by the import tool name the clinic and its city:
// «… لعيادات الأسنان في الرياض عن طريق …» and «… لزيادة المرضى في عيادة د. وائل، وحاب …»
const CITY_IN_MESSAGE = /لعيادات الأسنان في (.+?) عن طريق/;
const NAME_IN_MESSAGE = /لزيادة المرضى في (.+?)،/;

/**
 * The clinic's name for the script: the business name its own WhatsApp account shows
 * (`waName`, when it has one — a list can pair a number with the wrong clinic), else the
 * Arabic one from its message, else the saved name.
 */
export function clinicName(lead, waName) {
  return (
    waName?.trim() ||
    lead?.message?.match(NAME_IN_MESSAGE)?.[1]?.trim() ||
    lead?.name?.trim() ||
    "العيادة"
  );
}

/** The clinic's city: the saved one, else the one its message names, else "". */
export function clinicCity(lead) {
  return lead?.city?.trim() || lead?.message?.match(CITY_IN_MESSAGE)?.[1]?.trim() || "";
}

/** "[ في {city}]" keeps its text only when every placeholder inside has a value. */
export function fillTemplate(template, values) {
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
  return template
    .replace(/\[([^\]]*)\]/g, (_, part) =>
      [...part.matchAll(/\{(\w+)\}/g)].every(([, k]) => values[k]) ? fill(part) : "",
    )
    .replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const EMOJI_JOINERS = new RegExp(`[${String.fromCharCode(0xfe0f)}${String.fromCharCode(0x200d)}]`, "g");

/**
 * What the bot sends has no emoji, periods, commas or colons (the owner's style), not even
 * inside a clinic's name («عيادة د. وائل» → «عيادة د وائل»). Line breaks stay.
 */
export const cleanText = (text) =>
  String(text)
    .replace(EMOJI, " ")
    .replace(EMOJI_JOINERS, "")
    .replace(/[.,،؛:]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([؟?!])/g, "$1") // «Dr Smile 🦷؟» → «Dr Smile؟», not «Dr Smile ؟»
    .replace(/ *\n */g, "\n")
    .trim();

/**
 * Message number `step` (1 = the first after the greeting) for this clinic, or null.
 * `waName`: the business name on the clinic's WhatsApp, if known.
 */
export function scriptMessage(script, step, lead, waName) {
  const template = script[step - 1];
  if (!template) return null;
  return cleanText(fillTemplate(template, { name: clinicName(lead, waName), city: clinicCity(lead) }));
}

const TASHKEEL = new RegExp(`[${String.fromCharCode(0x64b)}-${String.fromCharCode(0x652)}${String.fromCharCode(0x640)}]`, "g");

/** Arabic text without diacritics/tatweel and with plain alef, so patterns stay simple. */
const plain = (text) =>
  String(text ?? "")
    .replace(TASHKEEL, "")
    .replace(/[أإآ]/g, "ا")
    .toLowerCase();

/** Seconds: a reply this fast after our message came from an auto-reply, not a person. */
export const AUTO_REPLY_SECONDS = 8;

// Phrases only automatic replies use
const AUTO_ALWAYS =
  /(رد\s*(الي|تلقائي)|رساله\s*(اليه|تلقائيه)|رسالة\s*(الية|تلقائية)|سيتم\s*(الرد|التواصل)|سنقوم\s*بالرد|سنرد|سوف\s*(نرد|يتم)|خارج\s*(اوقات|ساعات)|شكرا\s*(لك|لكم)?\s*(علي|على|ل)\s*(تواصل|التواصل|مراسلت)|لتواصلك|لتواصلكم|thanks? (you )?for (contacting|reaching|your message)|we will (get back|reply|respond)|auto-?reply|automatic reply|out of office)/;
// Words a long welcome/menu message has; a person's reply to a salam is short
const AUTO_LONG =
  /(اهلا|مرحب|نرحب|يسعدنا|نسعد|اوقات العمل|ساعات العمل|اوقات الدوام|للحجز|لحجز|الحجز|عروض|موقعنا|لوكيشن|https?:\/\/|wa\.me|instagram\.com)/;

/**
 * A WhatsApp Business auto-reply («شكرًا لتواصلك…», a welcome menu) rather than a person.
 * `secondsAfterOurs`: how long after our last message it arrived (null if unknown).
 */
export function isAutoReply(text, secondsAfterOurs) {
  if (secondsAfterOurs != null && secondsAfterOurs >= 0 && secondsAfterOurs < AUTO_REPLY_SECONDS) {
    return true;
  }
  const t = plain(text);
  return AUTO_ALWAYS.test(t) || (t.length >= 80 && AUTO_LONG.test(t));
}

// «مو مهتمين», «لا شكرا», «ما نحتاج», «نعتذر»… but not «لا ما عندي مانع» / «ما نمانع»
const REFUSAL =
  /((^|\s)(مو|مش|غير|ما|مب|ماني|لسنا|لا)\s*(مهتم|محتاج|نحتاج|احتاج|نبي|ابي|نبغي|نبغى|ابغي|ابغى|نرغب|ارغب)|مانحتاج|مانبي|مانبغى|مانبغي|لا\s*شكرا|لا\s*مشكور|لا\s*الله\s*يعافيك|نعتذر|اعتذر|لا\s*ترسل|لا\s*تراسل|(ارجو|الرجاء|نرجو)\s*عدم|عندنا\s*(شركه|شركة|مسوق|فريق)|متعاقدين|not interested|no thanks|unsubscribe)/;

/** The clinic says no: the bot stops and marks it «غير مهتم». */
export const isRefusal = (text) => REFUSAL.test(plain(text));

/**
 * What to do with a message from a lead, given how many messages the script has:
 * "ignore" (not greeted by us, or already said no), "auto" (an auto-reply: wait for a real
 * one), "refusal", "after-script" (answered the last script message: a person takes over),
 * or "reply" (send the next script message).
 */
export function incomingAction(lead, text, secondsAfterOurs, scriptLength) {
  if (!lead || !lead.greeted_at || lead.status === "not_interested") return "ignore";
  if (isAutoReply(text, secondsAfterOurs)) return "auto";
  if (isRefusal(text)) return "refusal";
  if ((lead.step ?? 0) >= scriptLength) return "after-script";
  return "reply";
}

/** `step` of a clinic you're talking to yourself: the bot sends it nothing more. */
export const TAKEN_OVER = 99;

/**
 * A message you sent yourself (phone or WhatsApp Web) to a lead: "greeting" (the site's
 * «التحية» button or a typed salam — the bot carries on from there), "takeover" (anything
 * else: you're handling this clinic, so no script and no follow-up) or "ignore".
 */
export function manualMessageAction(lead, text) {
  if (!lead) return "ignore";
  const words = cleanText(plain(text)).replace(/\s+/g, "");
  if (words.startsWith("السلامعليكم") && words.length <= 40) return "greeting";
  if ((lead.step ?? 0) >= TAKEN_OVER) return "ignore"; // already yours
  return "takeover";
}

/** The text of an incoming message: "" for a reply without text (voice note, sticker…), null for none. */
export function messageText(content) {
  if (!content) return null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption;
  if (typeof text === "string") return text;
  if (content.reactionMessage) return content.reactionMessage.text || null; // removed reaction: none
  const kinds = Object.keys(content).filter(
    (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage",
  );
  if (kinds.length === 0 || kinds.includes("protocolMessage")) return null;
  return "";
}

/** "16-21" → { from: 16, to: 21 } */
export function parseHours(text) {
  const m = String(text).trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`مواعيد غلط "${text}" — المفروض زي 16-21`);
  return { from: Number(m[1]), to: Number(m[2]) };
}

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
 * assignments of this sender (sent or not), with their leads. `lastOther`: when another
 * unprompted message (a follow-up) went out, which also needs the gap before the next one.
 * Returns { send: assignment } or { waitUntil: Date, reason }.
 */
export function planNextGreeting(now, schedule, assignments, gapMinutes, lastOther = null) {
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

  const last = [...greetedToday, lastOther].reduce((max, d) => (d && (!max || d > max) ? d : max), null);
  if (last) {
    const ready = new Date(last.getTime() + gapMinutes * 60_000);
    if (ready > now) return { waitUntil: ready, reason: "gap" };
  }

  const [next] = waitingForGreeting(assignments);
  if (!next) return { waitUntil: new Date(now.getTime() + 10 * 60_000), reason: "none-left" };
  return { send: next };
}

/* ---------- the conversation record (table messages, page «الردود») ---------- */

/**
 * One phone number from its digits, as "+<country code><number>", or null. `withCode`: it was
 * written with "+" or "00", so any 10–15 digits are a full international number. Without it:
 * Saudi mobiles in every form (05…, 5…, 9665…), Saudi landlines (01…, 9661…) and unified
 * numbers (920…), Egyptian mobiles (01x…), and Gulf / Jordan / Egypt numbers with their code.
 */
export function phoneFromDigits(digits, withCode = false) {
  const d = String(digits);
  if (withCode) return /^[1-9]\d{9,14}$/.test(d) ? `+${d}` : null;
  if (/^05\d{8}$/.test(d)) return `+966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `+966${d}`;
  if (/^01\d{8}$/.test(d)) return `+966${d.slice(1)}`; // Saudi landline (011 234 5678)
  if (/^920\d{6}$/.test(d)) return `+966${d}`; // Saudi unified number
  if (/^01[0125]\d{8}$/.test(d)) return `+20${d.slice(1)}`; // Egyptian mobile
  if (/^966(5|1|920)\d+$/.test(d) && d.length === 12) return `+${d}`;
  if (/^(965|973|974|968)\d{8}$/.test(d) || /^(971|962)\d{9}$/.test(d) || /^20\d{10}$/.test(d)) return `+${d}`;
  return null;
}

/**
 * The phone numbers written in a message, in order, each once: «0501234567», «050 123 4567»,
 * «+966 50 123 4567», «00966501234567», Arabic digits «٠٥٠١٢٣٤٥٦٧», a wa.me link…
 * Digit groups split by spaces/dashes/dots are joined until they make a number.
 */
export function phonesIn(text) {
  const t = toAsciiDigits(String(text ?? ""));
  const found = [];
  for (const [run] of t.matchAll(/\+?\d(?:[\s\-.()‎‏‪-‮]{0,3}\d)*/g)) {
    const groups = run.split(/[^\d+]+/).filter((g) => /\d/.test(g));
    for (let i = 0; i < groups.length; ) {
      const withCode = groups[i].startsWith("+") || groups[i].startsWith("00");
      let digits = "";
      let hit = null;
      let end = i;
      for (let j = i; j < groups.length; j++) {
        digits += groups[j].replace(/\D/g, "");
        if (digits.length > 17) break;
        const p = phoneFromDigits(digits.startsWith("00") ? digits.slice(2) : digits, withCode);
        if (p) {
          hit = p;
          end = j;
          break;
        }
      }
      if (hit) {
        if (!found.includes(hit)) found.push(hit);
        i = end + 1;
      } else i++;
    }
  }
  return found;
}

/** The numbers on a shared contact card (vCard): WhatsApp's own `waid=` first, else the TEL value. */
export function phonesInVcard(vcard) {
  const found = [];
  for (const line of String(vcard ?? "").split(/\r?\n/)) {
    if (!/^(item\d+\.)?TEL/i.test(line)) continue;
    const waid = line.match(/waid=(\d+)/i)?.[1];
    const phones = waid ? [phoneFromDigits(waid, true)].filter(Boolean) : phonesIn(line.slice(line.lastIndexOf(":") + 1));
    for (const p of phones) if (!found.includes(p)) found.push(p);
  }
  return found;
}

const str = (v) => (typeof v === "string" ? v : "");

/** A shared contact card for the record: «الاسم +966…». */
function contactLine(c) {
  const phones = phonesInVcard(c?.vcard);
  return [str(c?.displayName).trim(), ...phones].filter(Boolean).join(" ");
}

/**
 * What a WhatsApp message is, for the conversation record: { kind, body, phones } or null when
 * it is no message (a removed reaction, a protocol notice…). `body` is the text or the caption;
 * `phones` the numbers written in it or on a shared contact card.
 */
export function messageInfo(content) {
  if (!content) return null;
  const c = content;
  let kind = "text";
  let body = null;
  let phones = null;
  if (typeof c.conversation === "string") body = c.conversation;
  else if (c.extendedTextMessage) body = str(c.extendedTextMessage.text);
  else if (c.imageMessage) [kind, body] = ["image", str(c.imageMessage.caption)];
  else if (c.videoMessage || c.ptvMessage) [kind, body] = ["video", str((c.videoMessage ?? c.ptvMessage).caption)];
  else if (c.audioMessage) [kind, body] = [c.audioMessage.ptt ? "voice" : "audio", ""];
  else if (c.documentMessage) [kind, body] = ["document", str(c.documentMessage.caption) || str(c.documentMessage.fileName)];
  else if (c.stickerMessage) [kind, body] = ["sticker", ""];
  else if (c.contactMessage || c.contactsArrayMessage) {
    const cards = c.contactMessage ? [c.contactMessage] : (c.contactsArrayMessage.contacts ?? []);
    kind = "contact";
    body = cards.map(contactLine).filter(Boolean).join("\n");
    phones = [...new Set(cards.flatMap((card) => phonesInVcard(card?.vcard)))];
  } else if (c.locationMessage || c.liveLocationMessage) {
    const l = c.locationMessage ?? c.liveLocationMessage;
    kind = "location";
    body = [str(l.name), str(l.address)].filter(Boolean).join(" — ") || `${l.degreesLatitude ?? ""}, ${l.degreesLongitude ?? ""}`;
  } else if (c.reactionMessage) {
    if (!str(c.reactionMessage.text)) return null; // a removed reaction
    [kind, body] = ["reaction", c.reactionMessage.text];
  } else if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3) {
    [kind, body] = ["poll", str((c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3).name)];
  } else {
    // WhatsApp Business buttons, menus and the answers to them
    const business =
      c.buttonsResponseMessage?.selectedDisplayText ??
      c.listResponseMessage?.title ??
      c.templateButtonReplyMessage?.selectedDisplayText ??
      c.interactiveResponseMessage?.body?.text ??
      c.buttonsMessage?.contentText ??
      c.templateMessage?.hydratedTemplate?.hydratedContentText ??
      c.interactiveMessage?.body?.text ??
      c.listMessage?.description;
    if (typeof business === "string") body = business;
    else {
      const kinds = Object.keys(c).filter((k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage");
      if (kinds.length === 0 || kinds.includes("protocolMessage")) return null;
      [kind, body] = ["other", ""];
    }
  }
  return { kind, body: body ?? "", phones: phones ?? phonesIn(body) };
}

const MOBILE_AFTER_CODE = { "+966": /^5/, "+971": /^5/, "+965": /^[569]/, "+974": /^[3567]/, "+973": /^[36]/, "+968": /^[79]/, "+962": /^7/, "+20": /^1/ };

/** A mobile number (WhatsApp works on it); countries not listed count as mobile. */
export function isMobilePhone(phone) {
  const code = Object.keys(MOBILE_AFTER_CODE).find((c) => phone.startsWith(c));
  return code ? MOBILE_AFTER_CODE[code].test(phone.slice(code.length)) : true;
}

/**
 * The management's number in a clinic's message: the first mobile written in it (or on the
 * contact card it shared), else the first other number, leaving out the clinic's own number and
 * ours (`exclude`). null when there is none.
 */
export function managerPhoneIn(info, exclude = []) {
  const skip = new Set(exclude.filter(Boolean).map((p) => whatsappNumber(p)));
  const phones = (info?.phones ?? []).filter((p) => !skip.has(whatsappNumber(p)));
  return phones.find(isMobilePhone) ?? phones[0] ?? null;
}

/** Text without spaces, punctuation, emoji and diacritics, to compare messages loosely. */
const squash = (text) => plain(cleanText(text)).replace(/[\s\p{P}\p{S}]/gu, "");

/**
 * An old message of ours (fetched from the phone's history): the bot wrote it when it is one of
 * the bot's own texts (the greeting, a script message's first line, the follow-up), else you did.
 */
export function botAuthored(text, botTexts) {
  const t = squash(text);
  if (!t) return false;
  return botTexts.some((b) => {
    const first = squash(String(b).split("\n")[0]);
    return first && t.startsWith(first);
  });
}
