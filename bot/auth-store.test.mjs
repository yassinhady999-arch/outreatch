// The Supabase session store reads Baileys' own session files back exactly, and keeps writes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { useSupabaseAuthState, fileKey } from "./auth-store.mjs";

/** Just enough of the Supabase client for auth-store.mjs, over an in-memory table. */
function fakeDb(table = new Map()) {
  const result = (data) => Promise.resolve({ data, error: null });
  return {
    table,
    auth: { getUser: () => result({ user: { id: "u1" } }) },
    from: () => ({
      select: () => ({
        eq: (_c, session) => ({
          order: () => ({
            range: (a, b) =>
              result(
                [...table.values()]
                  .filter((r) => r.session === session)
                  .sort((x, y) => (x.key < y.key ? -1 : 1))
                  .slice(a, b + 1),
              ),
          }),
        }),
      }),
      upsert: (rows) => {
        for (const r of rows) table.set(`${r.session}/${r.key}`, r);
        return result(null);
      },
      delete: () => ({
        // Like the real client, nothing runs until it's awaited
        eq: (_c, session) => ({
          then: (ok, fail) => {
            for (const [k, r] of table) if (r.session === session) table.delete(k);
            return result(null).then(ok, fail);
          },
          in: (_k, keys) => {
            for (const key of keys) table.delete(`${session}/${key}`);
            return result(null);
          },
        }),
      }),
    }),
  };
}

test("reads and writes the same data as Baileys' file store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-"));
  const files = await useMultiFileAuthState(dir);
  await files.saveCreds();
  await files.state.keys.set({
    "pre-key": { 1: { public: Buffer.from([1, 2]), private: Buffer.from([3]) } },
    session: { "2010:1@s.whatsapp.net": { foo: Buffer.from("bar") } },
    "app-state-sync-key": { AAA: { keyData: Buffer.from([9, 9]) } },
  });

  // Copy the files in the way upload-session.mjs does
  const db = fakeDb();
  for (const name of fs.readdirSync(dir)) {
    const key = name.slice(0, -5);
    db.table.set(`s/${key}`, { session: "s", key, value: fs.readFileSync(path.join(dir, name), "utf8") });
  }
  const store = await useSupabaseAuthState(db, "s", () => {});
  assert.equal(store.isNew, false);
  assert.deepEqual(store.state.creds.noiseKey, files.state.creds.noiseKey);
  assert.equal(store.state.creds.registrationId, files.state.creds.registrationId);

  const got = await store.state.keys.get("pre-key", ["1", "2"]);
  assert.deepEqual(got["1"].public, Buffer.from([1, 2]));
  assert.equal(got["2"], null);
  const s = await store.state.keys.get("session", ["2010:1@s.whatsapp.net"]);
  assert.equal(Buffer.from(s["2010:1@s.whatsapp.net"].foo).toString(), "bar");
  const ask = await store.state.keys.get("app-state-sync-key", ["AAA"]);
  assert.deepEqual(Buffer.from(ask.AAA.keyData), Buffer.from([9, 9]));
  assert.equal(typeof ask.AAA.toJSON, "function"); // a proto object, like the file store returns

  // Writes and deletes reach the table, and a fresh start sees them
  await store.state.keys.set({ "pre-key": { 1: null, 3: { public: Buffer.from([7]) } } });
  store.state.creds.registrationId = 4242;
  await store.saveCreds();
  assert.ok(!db.table.has("s/pre-key-1"));
  assert.ok(db.table.has(`s/${fileKey("session-2010:1@s.whatsapp.net")}`));
  const again = await useSupabaseAuthState(db, "s", () => {});
  assert.equal(again.state.creds.registrationId, 4242);
  const k = await again.state.keys.get("pre-key", ["1", "3"]);
  assert.equal(k["1"], null);
  assert.deepEqual(Buffer.from(k["3"].public), Buffer.from([7]));

  await again.clear();
  assert.equal(db.table.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new session starts with fresh creds", async () => {
  const store = await useSupabaseAuthState(fakeDb(), "new", () => {});
  assert.equal(store.isNew, true);
  assert.ok(store.state.creds.noiseKey);
});

test("the linked session on this computer loads whole", { skip: !fs.existsSync("auth/default/creds.json") }, async () => {
  const db = fakeDb();
  for (const name of fs.readdirSync("auth/default")) {
    const key = name.slice(0, -5);
    db.table.set(`d/${key}`, { session: "default", key, value: fs.readFileSync(path.join("auth/default", name), "utf8") });
  }
  const store = await useSupabaseAuthState(db, "default", () => {});
  const creds = JSON.parse(fs.readFileSync("auth/default/creds.json", "utf8"));
  assert.equal(store.state.creds.me.id, creds.me.id);
  assert.ok(Buffer.isBuffer(store.state.creds.noiseKey.private));
});
