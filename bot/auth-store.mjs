// WhatsApp session kept in Supabase (table wa_auth, migration 0008) instead of bot/auth/,
// so the bot can run on a server whose disk is wiped on every restart.
// Same layout as Baileys' useMultiFileAuthState: one row per file, key = file name without
// ".json", value = the file's exact text. Reads come from memory (everything is loaded once
// at start, ~400 KB); writes go to the database in order, retried while it is unreachable.
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const PAGE = 1000; // PostgREST returns at most 1000 rows per request
const CHUNK = 500;

/** Same renaming Baileys does for its session files. */
export const fileKey = (name) => name.replace(/\//g, "__").replace(/:/g, "-");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every row of one session, as Map(key → text). */
export async function loadSession(db, session) {
  const rows = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("wa_auth")
      .select("key, value")
      .eq("session", session)
      .order("key")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`wa_auth: ${error.message}`);
    for (const row of data) rows.set(row.key, row.value);
    if (data.length < PAGE) return rows;
  }
}

/** Writes Map(key → text | null) to the database; null deletes the row. */
export async function writeRows(db, userId, session, changes) {
  const now = new Date().toISOString();
  const upserts = [];
  const deletes = [];
  for (const [key, value] of changes) {
    if (value === null) deletes.push(key);
    else upserts.push({ user_id: userId, session, key, value, updated_at: now });
  }
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const { error } = await db
      .from("wa_auth")
      .upsert(upserts.slice(i, i + CHUNK), { onConflict: "user_id,session,key" });
    if (error) throw new Error(`wa_auth: ${error.message}`);
  }
  for (let i = 0; i < deletes.length; i += CHUNK / 5) {
    const { error } = await db
      .from("wa_auth")
      .delete()
      .eq("session", session)
      .in("key", deletes.slice(i, i + CHUNK / 5));
    if (error) throw new Error(`wa_auth: ${error.message}`);
  }
}

/**
 * Drop-in for useMultiFileAuthState, backed by the wa_auth table.
 * Returns { state, saveCreds, flush, clear, isNew }.
 */
export async function useSupabaseAuthState(db, session, log = console.log) {
  const { data: auth } = await db.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) throw new Error("wa_auth: not signed in");

  const rows = await loadSession(db, session);
  const isNew = !rows.has("creds");

  // Each read parses the stored text again, like reading the file, so Baileys never
  // shares an object between two reads.
  const read = (key) => {
    const text = rows.get(key);
    return text === undefined ? null : JSON.parse(text, BufferJSON.reviver);
  };

  let dirty = new Map(); // key → text | null, not yet in the database
  let chain = Promise.resolve();
  let retryTimer = null;

  async function persist() {
    if (!dirty.size) return;
    const batch = dirty;
    dirty = new Map();
    for (let attempt = 1; ; attempt++) {
      try {
        await writeRows(db, userId, session, batch);
        return;
      } catch (e) {
        if (attempt === 5) {
          // Keep it (unless something newer came) and try again later; memory stays right
          for (const [k, v] of batch) if (!dirty.has(k)) dirty.set(k, v);
          log("⚠️ تعذّر حفظ جلسة واتساب في قاعدة البيانات، هحاول تاني:", e.message);
          retryTimer ??= setTimeout(() => {
            retryTimer = null;
            flush();
          }, 60_000);
          return;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** Resolves once every change so far is in the database (or queued for a retry). */
  function flush() {
    chain = chain.then(persist);
    return chain;
  }

  function change(key, value) {
    const text = value ? JSON.stringify(value, BufferJSON.replacer) : null;
    if (text === null) rows.delete(key);
    else rows.set(key, text);
    dirty.set(key, text);
  }

  const creds = read("creds") || initAuthCreds();

  return {
    isNew,
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = read(fileKey(`${type}-${id}`));
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              change(fileKey(`${category}-${id}`), data[category][id]);
            }
          }
          await flush();
        },
      },
    },
    saveCreds: async () => {
      change("creds", creds);
      await flush();
    },
    flush,
    /** Forgets the session (after the phone logged this device out). */
    clear: async () => {
      rows.clear();
      dirty = new Map();
      await chain;
      const { error } = await db.from("wa_auth").delete().eq("session", session);
      if (error) throw new Error(`wa_auth: ${error.message}`);
    },
  };
}
