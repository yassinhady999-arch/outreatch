// Mersal bot: links one WhatsApp number (QR, like WhatsApp Web), greets today's assigned
// clinics on its own, and sends each clinic its own message after its first reply.
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
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import QRCode from "qrcode";
import qrTerminal from "qrcode-terminal";
import { useSupabaseAuthState } from "./auth-store.mjs";
import {
  DEFAULT_SCHEDULE,
  GREETING,
  parseSchedule,
  phoneCandidates,
  phoneToJid,
  planNextGreeting,
  randomBetween,
  replyAction,
  toISODate,
  whatsappNumber,
  withoutSalam,
} from "./core.mjs";

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
// Minutes after a clinic's reply before its own message goes out
const REPLY_DELAY = Number(env("REPLY_DELAY_MINUTES", "3"));
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

async function leadForPhone(pnJid) {
  const { data, error } = await db
    .from("leads")
    .select("id, phone, name, message, greeted_at, status")
    .in("phone", phoneCandidates(pnJid))
    .limit(1);
  if (error) throw error;
  const lead = data[0] ?? null;
  if (!lead) return { lead: null, assignment: null };
  const { data: a } = await db
    .from("assignments")
    .select("id, sent")
    .eq("lead_id", lead.id)
    .maybeSingle();
  return { lead, assignment: a ?? null };
}

/* ---------- WhatsApp ---------- */

let sock = null;
let sender = null;
let connected = false;
let pendingQr = null; // shown at /qr while the number isn't linked
const replying = new Set(); // lead ids whose message is on its way

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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (m.key.fromMe || !jid || !(jid.endsWith("@s.whatsapp.net") || isLidUser(jid))) continue;
      onIncoming(m, jid).catch((e) => log("خطأ وأنا برد:", e.message));
    }
  });
}

/** First reply after the greeting → the clinic's own message, once. */
async function onIncoming(m, jid) {
  // Chats can be addressed by a hidden id (LID); the phone number comes with it or from the map
  const pnJid = isLidUser(jid)
    ? (m.key.remoteJidAlt ?? (await sock.signalRepository.lidMapping.getPNForLID(jid)))
    : jid;
  if (!pnJid) return;
  const { lead, assignment } = await leadForPhone(pnJid);
  const action = replyAction(lead, assignment);
  if (action === "ignore" || replying.has(lead.id)) return;
  // The greeting already said the salam, so the message starts after its first line
  const text = withoutSalam(lead.message);
  if (action === "no-message" || !text) {
    log(`↩️ ${lead.name || lead.phone} ردّت، بس مالهاش رسالة مخصصة — ابعتلها بنفسك.`);
    return;
  }
  replying.add(lead.id);
  try {
    log(`↩️ ${lead.name || lead.phone} ردّت — رسالتها هتتبعت بعد ${REPLY_DELAY} دقايق`);
    await sleep(REPLY_DELAY * 60_000);
    await sock.sendMessage(jid, { text });
    await db
      .from("assignments")
      .update({ sent: true, sent_at: new Date().toISOString() })
      .eq("id", assignment.id);
    await db.from("leads").update({ status: "replied" }).eq("id", lead.id);
    log(`✓ اتبعتت الرسالة المخصصة لـ ${lead.name || lead.phone}`);
  } finally {
    replying.delete(lead.id);
  }
}

const WAIT_REASON = {
  outside: "برّه مواعيد الإرسال",
  "window-full": "خلصت تحيات الفترة دي",
  gap: "بين كل تحية والتانية",
  "none-left": "مفيش عيادات مستنية تحية دلوقتي",
};
const clock = (d) => d.toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" });

/** Greets today's clinics one at a time, following SCHEDULE, GAP_MIN–GAP_MAX minutes apart. */
async function greetLoop() {
  let gap = randomBetween(GAP_MIN, GAP_MAX);
  let lastNote = "";
  for (;;) {
    try {
      if (!connected || !sender || !sender.active) {
        await sleep(30_000);
        continue;
      }
      const plan = planNextGreeting(new Date(), SCHEDULE, await todaysAssignments(sender.id), gap);
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
      await sock.sendMessage(check.jid || phoneToJid(lead.phone), { text: GREETING });
      await db.from("leads").update({ greeted_at: new Date().toISOString() }).eq("id", lead.id);
      log(`✓ التحية اتبعتت لـ ${lead.name || lead.phone}`);
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
    .listen(Number(process.env.PORT), () => log(`صفحة الحالة شغالة على البورت ${process.env.PORT}`));

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
    `بينهم ${GAP_MIN}–${GAP_MAX} دقيقة · الرسالة بعد الرد بـ ${REPLY_DELAY} دقايق`,
);
await connect();
greetLoop();
