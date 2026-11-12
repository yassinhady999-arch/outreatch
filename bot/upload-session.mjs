// Copies the WhatsApp session linked on this computer (bot/auth/<session>/) into the
// database (table wa_auth), so the bot on the server starts already linked, without a QR.
// Stop the bot on this computer first, and don't run both: one number = one running bot.
// Usage: node --env-file=.env upload-session.mjs [sessionName]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadSession, writeRows } from "./auth-store.mjs";

const session = process.argv[2] || "default";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "auth", session);
if (!fs.existsSync(path.join(dir, "creds.json"))) {
  console.error(`مفيش جلسة مربوطة في ${dir}`);
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signIn, error } = await db.auth.signInWithPassword({
  email: process.env.BOT_EMAIL,
  password: process.env.BOT_PASSWORD,
});
if (error) {
  console.error("تعذّر تسجيل الدخول:", error.message);
  process.exit(1);
}

const files = new Map();
for (const name of fs.readdirSync(dir)) {
  if (name.endsWith(".json")) files.set(name.slice(0, -5), fs.readFileSync(path.join(dir, name), "utf8"));
}

// Replace whatever was there before for this session
const old = await loadSession(db, session);
const changes = new Map(files);
for (const key of old.keys()) if (!files.has(key)) changes.set(key, null);
await writeRows(db, signIn.user.id, session, changes);

const saved = await loadSession(db, session);
const same = saved.size === files.size && [...files].every(([k, v]) => saved.get(k) === v);
console.log(
  same
    ? `✓ اترفعت الجلسة «${session}» (${files.size} ملف) لقاعدة البيانات`
    : `✗ اللي اتحفظ مش مطابق (${saved.size} من ${files.size}) — شغّل الأمر تاني`,
);
process.exit(same ? 0 : 1);
