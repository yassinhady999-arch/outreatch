// Mersal bot: links one WhatsApp number (QR, like WhatsApp Web), greets today's assigned
// clinics on its own, then holds the conversation in script.mjs: each real reply from a
// clinic gets the next message, and a clinic that never answers gets one follow-up.
// Usage: node --env-file=.env index.mjs [sessionName]   (one session per sending number)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import QRCode from "qrcode";
import qrTerminal from "qrcode-terminal";
import { useSupabaseAuthState } from "./auth-store.mjs";
import {
  cleanText,
  DEFAULT_SCHEDULE,
  GREETING,
  incomingAction,
  manualMessageAction,
  messageText,
  parseHours,
  parseSchedule,
  phoneCandidates,
  phoneToJid,
  planNextGreeting,
  randomBetween,
  scriptMessage,
  TAKEN_OVER,
  toISODate,
  whatsappNumber,
  withinHours,
} from "./core.mjs";
import { FOLLOW_UP, SCRIPT } from "./script.mjs";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    console.error(`ناقص ${name} في ملف bot/.env — افتح الملف واكتبه.`);
    process.exit(1);
  }
  return value;
};

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
const BOT_EMAIL = env("BOT_EMAIL");
const BOT_PASSWORD = env("BOT_PASSWORD");
// Greetings per time window, e.g. 5 between 9 and 12 (see DEFAULT_SCHEDULE)
const SCHEDULE = parseSchedule(env("SCHEDULE", DEFAULT_SCHEDULE));
// Minutes between two greetings (a fresh random value after each one)
const GAP_MIN = Number(env("GAP_MIN_MINUTES", "15"));
const GAP_MAX = Number(env("GAP_MAX_MINUTES", "25"));
// Minutes after a clinic's reply before the next message goes out
const REPLY_DELAY = Number(env("REPLY_DELAY_MINUTES", "3"));
// Hours when the «did my message arrive?» follow-up may go out (it says «مساء الخير»)
const FOLLOW_UP_HOURS = parseHours(env("FOLLOW_UP_HOURS", "16-21"));
// …to a clinic that hasn't answered the greeting for this long, and not after FOLLOW_UP_MAX_DAYS
const FOLLOW_UP_AFTER_HOURS = 24;
const FOLLOW_UP_MAX_DAYS = 3;
// Where the WhatsApp session lives: "files" (bot/auth/) or "supabase" (table wa_auth,
// needed on a server like Render whose disk is wiped on every restart)
const SESSION_STORE = env("SESSION_STORE", "files");

const session = process.argv[2] || process.env.SESSION_NAME || "default";
const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(here, "auth", session);
const qrFile = path.join(here, `qr-${session}.png`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Also kept in bot/bot.log, to see what happened while nobody watched the window
const logFile = path.join(here, "bot.log");
const log = (...args) => {
  const now = new Date();
  console.log(`[${now.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}]`, ...args);
  fs.appendFile(logFile, `[${now.toLocaleString("ar-EG")}] ${args.join(" ")}\n`, () => {});
};

// Anything unexpected: log it and exit, so start-bot.bat starts the bot again
for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (err) => {
    log(`وقف بسبب خطأ غير متوقع (${event}):`, err?.stack || err);
    setTimeout(() => process.exit(1), 500);
  });
}

/* ---------- database (as the site user, so it only sees their own data) ---------- */

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: true },
});
{
  const { error } = await db.auth.signInWithPassword({ email: BOT_EMAIL, password: BOT_PASSWORD });
  if (error) {
    console.error("تعذّر تسجيل الدخول للموقع بالإيميل والباسورد اللي في bot/.env:", error.message);
    process.exit(1);
  }
  log("✓ اتسجّل الدخول للموقع");
}

/** The sending number in the site's «أرقام الإرسال» that this WhatsApp account is. */
async function findSender(ownJid) {
  const own = ownJid.split("@")[0];
  const { data, error } = await db.from("senders").select("id, phone, label, active, daily_limit");
  if (error) throw error;
  return data.find((s) => whatsappNumber(s.phone) === own) ?? null;
}

/** All of today's assignments of this sender (sent or not), with their leads. */
async function todaysAssignments(senderId) {
  const today = toISODate(new Date());
  // Rolls yesterday's ungreeted clinics over and fills today's slots, same as opening the site
  await db.rpc("distribute_leads", { p_today: today });
  const { data, error } = await db
    .from("assignments")
    .select("id, sent, created_at, leads(id, phone, name, message, greeted_at, status, no_whatsapp)")
    .eq("sender_id", senderId)
    .eq("assign_date", today);
  if (error) throw error;
  return data;
}

const LEAD_FIELDS =
  "id, phone, name, city, message, greeted_at, status, step, last_out_at, reply_pending_at, replied_at";

async function leadForPhone(pnJid) {
  const { data, error } = await db
    .from("leads")
    .select(LEAD_FIELDS)
    .in("phone", phoneCandidates(pnJid))
    .limit(1);
  if (error) throw error;
  return data[0] ?? null;
}

/** Replies waiting at least REPLY_DELAY minutes for this number's next script message. */
async function dueReplies() {
  let q = db
    .from("leads")
    .select(`${LEAD_FIELDS}, assignments!inner(sender_id)`)
    .not("reply_pending_at", "is", null)
    .lte("reply_pending_at", new Date(Date.now() - REPLY_DELAY * 60_000).toISOString())
    .order("reply_pending_at")
    .limit(5);
  if (sender) q = q.eq("assignments.sender_id", sender.id);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/** The oldest clinic of this number that never answered its greeting (24 h – 3 days ago). */
async function dueFollowUp() {
  const now = Date.now();
  let q = db
    .from("leads")
    .select("id, phone, name, assignments!inner(sender_id, sent)")
    // Not one marked «اتبعت»: someone already wrote to it (e.g. you, from the site)
    .eq("assignments.sent", false)
    .eq("step", 0)
    .eq("status", "assigned")
    .eq("no_whatsapp", false)
    .is("followed_up_at", null)
    .is("reply_pending_at", null)
    .lte("greeted_at", new Date(now - FOLLOW_UP_AFTER_HOURS * 3600_000).toISOString())
    .gte("greeted_at", new Date(now - FOLLOW_UP_MAX_DAYS * 86400_000).toISOString())
    .order("greeted_at")
    .limit(1);
  if (sender) q = q.eq("assignments.sender_id", sender.id);
  const { data, error } = await q;
  if (error) throw error;
  return data[0] ?? null;
}

/* ---------- WhatsApp ---------- */

let sock = null;
let sender = null;
let connected = false;
let pendingQr = null; // shown at /qr while the number isn't linked

/** The session store, opened once and kept across reconnects. */
let auth = null;
async function openAuth() {
  if (SESSION_STORE === "supabase") {
    const store = await useSupabaseAuthState(db, session, log);
    log(store.isNew ? "مفيش جلسة واتساب محفوظة — هيظهر كود QR" : "✓ جلسة واتساب اتقرت من قاعدة البيانات");
    return store;
  }
  fs.mkdirSync(authDir, { recursive: true });
  const store = await useMultiFileAuthState(authDir);
  return {
    ...store,
    flush: async () => {},
    clear: async () => fs.rmSync(authDir, { recursive: true, force: true }),
  };
}

async function connect() {
  auth ??= await openAuth();
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: auth.state,
    browser: Browsers.windows("Mersal"),
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });
  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      pendingQr = qr;
      qrTerminal.generate(qr, { small: true });
      if (process.platform === "win32") {
        await QRCode.toFile(qrFile, qr, { width: 360 });
        exec(`start "" "${qrFile}"`);
      }
      log(
        "امسح الكود من واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز." +
          (PUBLIC_URL ? ` الكود كمان في ${PUBLIC_URL}/qr` : ""),
      );
    }
    if (connection === "open") {
      connected = true;
      pendingQr = null;
      fs.rmSync(qrFile, { force: true });
      const ownJid = jidNormalizedUser(sock.user.id);
      sender = await findSender(ownJid).catch(() => null);
      log(`✓ واتساب متصل (${ownJid.split("@")[0]})`);
      if (!sender) log("⚠️ الرقم ده مش متسجل في «أرقام الإرسال» على الموقع — هرد على العيادات بس، ومش هبعت تحيات.");
      else log(`رقم الإرسال: ${sender.label || sender.phone} · الحد اليومي ${sender.daily_limit}`);
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        await auth.clear().catch((e) => log("تعذّر مسح الجلسة:", e.message));
        log("اتعمل تسجيل خروج للجهاز من الموبايل. البوت هيبدأ من جديد ويطلب كود QR.");
        process.exit(1);
      }
      // Another copy of the bot opened the same number (e.g. the laptop and the server at
      // once). Back off so the two don't keep kicking each other out.
      const replaced = code === DisconnectReason.connectionReplaced;
      const wait = replaced ? 10 * 60_000 : 5000;
      log(
        replaced
          ? "⚠️ نسخة تانية من البوت فتحت نفس الرقم — هستنى 10 دقايق. شغّل البوت في مكان واحد بس."
          : "الاتصال وقع، بيرجع يتصل…",
      );
      setTimeout(() => connect().catch((e) => log("تعذّر الاتصال:", e.message)), wait);
    }
  });

  // "notify": new messages. "append": messages that arrived while the bot was offline
  // (a restart), plus the bot's own sends, which are skipped by their id.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!jid || !(jid.endsWith("@s.whatsapp.net") || isLidUser(jid))) continue;
      if (!m.key.fromMe) onIncoming(m, jid).catch((e) => log("خطأ وأنا برد:", e.message));
      else if (!botSent.has(m.key.id)) onManual(m, jid).catch((e) => log("خطأ:", e.message));
    }
  });
}

const who = (lead) => lead.name || lead.phone;
const snippet = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text).replace(/\s+/g, " ");

// Ids of the messages the bot sent, to tell them from the ones you write yourself
const botSent = new Set();
// lead id → the business name its WhatsApp account showed on its last message
const waNames = new Map();

/** "Typing…" for a few seconds first, like a person, then the message. */
async function typeAndSend(jid, text) {
  try {
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(randomBetween(3, 7) * 1000);
    await sock.sendPresenceUpdate("paused", jid);
  } catch {}
  const messageId = generateMessageIDV2(sock.user?.id);
  botSent.add(messageId);
  if (botSent.size > 2000) botSent.delete(botSent.values().next().value);
  await sock.sendMessage(jid, { text }, { messageId });
}

/** The phone-number id of a chat (chats can be addressed by a hidden id, a LID). */
async function phoneJidOf(m, jid) {
  return isLidUser(jid)
    ? (m.key.remoteJidAlt ?? (await sock.signalRepository.lidMapping.getPNForLID(jid)))
    : jid;
}

/**
 * A message you wrote yourself to a clinic (phone, WhatsApp Web, the site's buttons). After
 * the greeting the bot carries on; anything else means you're handling it: no script and
 * no follow-up from the bot, and its replies get «متابعة».
 */
async function onManual(m, jid) {
  const text = messageText(normalizeMessageContent(m.message));
  if (text === null) return;
  const pnJid = await phoneJidOf(m, jid);
  if (!pnJid) return;
  const lead = await leadForPhone(pnJid);
  const action = manualMessageAction(lead, text);
  if (action === "ignore") return;
  const at = new Date(Number(m.messageTimestamp) * 1000 || Date.now()).toISOString();
  const patch = { last_out_at: at, ...(lead.greeted_at ? {} : { greeted_at: at }) };
  if (action === "takeover") Object.assign(patch, { step: TAKEN_OVER, reply_pending_at: null });
  const { error } = await db.from("leads").update(patch).eq("id", lead.id);
  if (error) throw error;
  if (action === "takeover") log(`✋ إنت كلّمت ${who(lead)} بنفسك — البوت مش هيبعتلها حاجة تاني`);
}

/**
 * A message from a clinic. A real reply gets the next script message REPLY_DELAY minutes
 * later (replyLoop sends it; noted in the database so a restart doesn't lose it).
 */
async function onIncoming(m, jid) {
  const text = messageText(normalizeMessageContent(m.message));
  if (text === null) return; // not a message (a removed reaction, a protocol notice…)
  const pnJid = await phoneJidOf(m, jid);
  if (!pnJid) return;
  const lead = await leadForPhone(pnJid);
  if (lead && m.verifiedBizName) waNames.set(lead.id, m.verifiedBizName);
  const ourLast = lead?.last_out_at ?? lead?.greeted_at;
  const at = Number(m.messageTimestamp) * 1000 || Date.now();
  const seconds = ourLast ? (at - new Date(ourLast).getTime()) / 1000 : null;
  // The first real answer (not an auto-reply), for the analytics page's response time
  const firstReply = lead && !lead.replied_at ? { replied_at: new Date(at).toISOString() } : {};

  switch (incomingAction(lead, text, seconds, SCRIPT.length)) {
    case "ignore":
      return;
    case "auto":
      log(`🤖 ${who(lead)}: رد آلي («${snippet(text)}») — مستني رد حقيقي`);
      return;
    case "after-script":
      if (lead.status !== "follow_up") {
        await db.from("leads").update({ status: "follow_up", ...firstReply }).eq("id", lead.id);
        log(`⭐ ${who(lead)} ردّت على آخر رسالة («${snippet(text)}») — كمّل معاها إنت (اتعلّمت «متابعة»)`);
      }
      return;
    case "refusal":
      await db
        .from("leads")
        .update({ status: "not_interested", reply_pending_at: null, ...firstReply })
        .eq("id", lead.id);
      log(`🚫 ${who(lead)} مش مهتمة («${snippet(text)}») — وقفت معاها`);
      return;
    case "reply":
      if (lead.reply_pending_at) return; // the next message is already on its way
      await db
        .from("leads")
        .update({ reply_pending_at: new Date().toISOString(), ...firstReply })
        .eq("id", lead.id)
        .is("reply_pending_at", null);
      log(`↩️ ${who(lead)} ردّت («${snippet(text)}») — الرسالة ${(lead.step ?? 0) + 1} هتتبعت بعد ${REPLY_DELAY} دقايق`);
  }
}

/** Sends the next script message to a clinic whose reply is waiting. */
async function sendNextStep(lead) {
  const step = (lead.step ?? 0) + 1;
  const waName = waNames.get(lead.id);
  const text = scriptMessage(SCRIPT, step, lead, waName);
  const now = new Date().toISOString();
  if (!text) {
    await db.from("leads").update({ reply_pending_at: null }).eq("id", lead.id);
    return;
  }
  await typeAndSend(phoneToJid(lead.phone), text);
  const last = step >= SCRIPT.length;
  const { error } = await db
    .from("leads")
    .update({ step, last_out_at: now, reply_pending_at: null, status: last ? "replied" : "contacted" })
    .eq("id", lead.id);
  if (error) throw error;
  if (last) {
    await db.from("assignments").update({ sent: true, sent_at: now }).eq("lead_id", lead.id);
  }
  if (waName && step === 1) log(`ℹ️ الاسم على واتساب «${waName}» — في البيانات «${who(lead)}»`);
  log(`✓ الرسالة ${step} اتبعتت لـ ${who(lead)}${last ? " — دي آخر رسالة، ولو ردّت هتتعلّم «متابعة»" : ""}`);
}

/** Every 20 seconds: answers the replies that waited REPLY_DELAY minutes. */
async function replyLoop() {
  for (;;) {
    try {
      if (connected) for (const lead of await dueReplies()) await sendNextStep(lead);
    } catch (e) {
      log("خطأ وأنا برد:", e.message);
    }
    await sleep(20_000);
  }
}

const WAIT_REASON = {
  outside: "برّه مواعيد الإرسال",
  "window-full": "خلصت تحيات الفترة دي",
  gap: "بين كل تحية والتانية",
  "none-left": "مفيش عيادات مستنية تحية دلوقتي",
};
const clock = (d) => d.toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" });

/**
 * Greets today's clinics one at a time, following SCHEDULE, GAP_MIN–GAP_MAX minutes apart.
 * When the window's greetings are done (or none are waiting), the evening follow-ups use
 * the same spacing.
 */
async function greetLoop() {
  let gap = randomBetween(GAP_MIN, GAP_MAX);
  let lastNote = "";
  let lastFollowUp = null;
  let lastSent = null; // greeting or follow-up: the next one waits the gap after it
  for (;;) {
    try {
      if (!connected || !sender || !sender.active) {
        await sleep(30_000);
        continue;
      }
      const now = new Date();
      const plan = planNextGreeting(now, SCHEDULE, await todaysAssignments(sender.id), gap, lastFollowUp);
      const followUpTime =
        (plan.reason === "window-full" || plan.reason === "none-left") &&
        withinHours(now, FOLLOW_UP_HOURS.from, FOLLOW_UP_HOURS.to) &&
        (!lastSent || now - lastSent >= gap * 60_000);
      const followUp = followUpTime ? await dueFollowUp() : null;
      if (followUp) {
        await typeAndSend(phoneToJid(followUp.phone), cleanText(FOLLOW_UP));
        await db
          .from("leads")
          .update({ followed_up_at: now.toISOString(), last_out_at: now.toISOString() })
          .eq("id", followUp.id);
        log(`🔔 رسالة المتابعة اتبعتت لـ ${who(followUp)} (ما ردّتش على التحية من 24 ساعة)`);
        lastFollowUp = lastSent = now;
        gap = randomBetween(GAP_MIN, GAP_MAX);
        lastNote = "";
        continue;
      }
      if (!plan.send) {
        const note = `⏳ ${WAIT_REASON[plan.reason]} — التحية الجاية بعد ${clock(plan.waitUntil)}`;
        if (note !== lastNote) log((lastNote = note));
        // Re-check at least every 10 minutes (new clinics, reconnects, settings)
        await sleep(Math.min(Math.max(plan.waitUntil - Date.now(), 1000), 10 * 60_000));
        continue;
      }
      const lead = plan.send.leads;
      const [check] = (await sock.onWhatsApp(whatsappNumber(lead.phone))) ?? [];
      if (!check?.exists) {
        await db.from("leads").update({ no_whatsapp: true }).eq("id", lead.id);
        log(`✗ ${lead.name || lead.phone} مالوش واتساب — اتعلّم «بدون واتساب»`);
        continue;
      }
      await typeAndSend(check.jid || phoneToJid(lead.phone), GREETING);
      const sentAt = new Date().toISOString();
      await db.from("leads").update({ greeted_at: sentAt, last_out_at: sentAt }).eq("id", lead.id);
      log(`✓ التحية اتبعتت لـ ${lead.name || lead.phone}`);
      lastSent = new Date();
      gap = randomBetween(GAP_MIN, GAP_MAX);
      lastNote = "";
    } catch (e) {
      log("خطأ:", e.message);
      await sleep(60_000);
    }
  }
}

/* ---------- web page (for hosts like Render that expect one) ---------- */

// Render gives the service's address; a visit every 10 minutes keeps its free plan from
// putting the bot to sleep (it sleeps after 15 minutes without visits).
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";

/** /qr is for the site owner only: the browser asks for a password (the site's password). */
function allowed(req) {
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  return pass === BOT_PASSWORD;
}

if (process.env.PORT) {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/qr") {
        if (!allowed(req)) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Mersal bot", charset="UTF-8"' });
          return res.end("password needed");
        }
        const body = connected
          ? "<h2>✓ واتساب متصل — مفيش كود محتاج يتمسح</h2>"
          : pendingQr
            ? `<h2>امسح الكود من واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</h2>
               <img src="${await QRCode.toDataURL(pendingQr, { width: 360 })}" alt="QR">
               <p>الكود بيتغير كل شوية — الصفحة بتتحدث لوحدها.</p>`
            : "<h2>بيجهّز الكود…</h2>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
            `<meta http-equiv="refresh" content="${connected ? 60 : 15}"><title>Mersal bot</title>` +
            `<body dir="rtl" style="font-family:sans-serif;text-align:center;padding:24px">${body}</body>`,
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, whatsapp: connected ? "connected" : pendingQr ? "needs-qr" : "connecting" }));
    })
    // Some hosts (alwaysdata) also say which address to listen on
    .listen(
      ...[Number(process.env.PORT), process.env.IP].filter((v) => v !== undefined && v !== ""),
      () => log(`صفحة الحالة شغالة على البورت ${process.env.PORT}`),
    );

  if (PUBLIC_URL) {
    setInterval(() => fetch(`${PUBLIC_URL}/health`).catch(() => {}), 10 * 60_000);
  }
}

async function stop(signal) {
  log(`البوت وقف (${signal}).`);
  await auth?.flush().catch(() => {});
  sock?.end(undefined);
  process.exit(0);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

log(
  `مِرسال بوت — الجلسة «${session}» · التحيات: ${SCHEDULE.map((w) => `${w.count} من ${w.from} لـ ${w.to}`).join("، ")} · ` +
    `بينهم ${GAP_MIN}–${GAP_MAX} دقيقة · كل رسالة بعد الرد بـ ${REPLY_DELAY} دقايق · المتابعة من ${FOLLOW_UP_HOURS.from} لـ ${FOLLOW_UP_HOURS.to}`,
);
await connect();
greetLoop();
replyLoop();
