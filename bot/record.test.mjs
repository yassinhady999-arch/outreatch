import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  botAuthored,
  GREETING,
  isMobilePhone,
  managerPhoneIn,
  messageInfo,
  phoneFromDigits,
  phonesIn,
  phonesInVcard,
} from "./core.mjs";
import { FOLLOW_UP, SCRIPT } from "./script.mjs";

/* ---------- the conversation record and the management number (page «الردود») ---------- */

test("Saudi numbers in every way clinics write them", () => {
  assert.deepEqual(phonesIn("رقم المدير 0501234567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("050 123 4567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("050-123-4567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("+966 50 123 4567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("00966501234567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("966501234567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("501234567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("٠٥٠١٢٣٤٥٦٧"), ["+966501234567"]); // Arabic digits
  assert.deepEqual(phonesIn("https://wa.me/966501234567"), ["+966501234567"]);
  assert.deepEqual(phonesIn("011 234 5678"), ["+966112345678"]); // landline
  assert.deepEqual(phonesIn("920012345"), ["+966920012345"]); // unified number
});

test("other countries, two numbers in one message, and what is not a number", () => {
  assert.deepEqual(phonesIn("01001234567"), ["+201001234567"]); // Egyptian mobile
  assert.deepEqual(phonesIn("+971 50 123 4567"), ["+971501234567"]);
  assert.deepEqual(phonesIn("0501234567 او 0559876543"), ["+966501234567", "+966559876543"]);
  assert.deepEqual(phonesIn("0501234567\n0501234567"), ["+966501234567"]); // once
  assert.deepEqual(phonesIn("الكشف 150 ريال، الساعة 10:30، يوم 2026/11/24"), []);
  assert.deepEqual(phonesIn("السجل التجاري 1010123456"), []);
  assert.deepEqual(phonesIn(""), []);
  assert.deepEqual(phonesIn(null), []);
  assert.equal(phoneFromDigits("12345"), null);
});

test("a shared contact card gives its WhatsApp number", () => {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:د خالد",
    "item1.TEL;waid=966501234567:+966 50 123 4567",
    "item1.X-ABLabel:جوال",
    "TEL;type=WORK:011 234 5678",
    "END:VCARD",
  ].join("\n");
  assert.deepEqual(phonesInVcard(vcard), ["+966501234567", "+966112345678"]);
  const info = messageInfo({ contactMessage: { displayName: "د خالد", vcard } });
  assert.equal(info.kind, "contact");
  assert.ok(info.body.includes("د خالد"));
  assert.equal(managerPhoneIn(info), "+966501234567");
});

test("what a message is, for the record", () => {
  assert.deepEqual(messageInfo({ conversation: "تفضل 0501234567" }), {
    kind: "text",
    body: "تفضل 0501234567",
    phones: ["+966501234567"],
  });
  assert.equal(messageInfo({ extendedTextMessage: { text: "تمام" } }).body, "تمام");
  assert.deepEqual(messageInfo({ imageMessage: { caption: "العرض" } }), { kind: "image", body: "العرض", phones: [] });
  assert.equal(messageInfo({ audioMessage: { ptt: true } }).kind, "voice");
  assert.equal(messageInfo({ audioMessage: {} }).kind, "audio");
  assert.equal(messageInfo({ documentMessage: { fileName: "profile.pdf" } }).body, "profile.pdf");
  assert.equal(messageInfo({ stickerMessage: {} }).kind, "sticker");
  assert.equal(messageInfo({ locationMessage: { name: "عيادة", address: "الرياض" } }).body, "عيادة — الرياض");
  assert.equal(messageInfo({ reactionMessage: { text: "👍" } }).kind, "reaction");
  assert.equal(messageInfo({ reactionMessage: { text: "" } }), null); // a removed reaction
  assert.equal(messageInfo({ protocolMessage: {} }), null);
  assert.equal(messageInfo({ messageContextInfo: {} }), null);
  assert.equal(messageInfo(null), null);
  // WhatsApp Business menus keep their text
  assert.equal(messageInfo({ buttonsResponseMessage: { selectedDisplayText: "الحجز" } }).body, "الحجز");
  assert.equal(messageInfo({ templateMessage: { hydratedTemplate: { hydratedContentText: "أهلا" } } }).body, "أهلا");
  assert.deepEqual(messageInfo({ pollUpdateMessage: {} }), { kind: "other", body: "", phones: [] });
});

test("the management number: a mobile first, never the clinic's own number or ours", () => {
  const info = messageInfo({ conversation: "تواصل مع الادارة 0112345678 او 0501234567" });
  assert.equal(managerPhoneIn(info), "+966501234567");
  assert.equal(managerPhoneIn(messageInfo({ conversation: "0112345678" })), "+966112345678");
  const own = messageInfo({ conversation: "رقمنا 0555123730 والمدير 0501234567" });
  assert.equal(managerPhoneIn(own, ["+966555123730"]), "+966501234567");
  assert.equal(managerPhoneIn(messageInfo({ conversation: "0555123730" }), ["966555123730"]), null);
  assert.equal(managerPhoneIn(messageInfo({ conversation: "وعليكم السلام" })), null);
  assert.equal(isMobilePhone("+966501234567"), true);
  assert.equal(isMobilePhone("+966112345678"), false);
  assert.equal(isMobilePhone("+201001234567"), true);
});

test("old messages from the phone: the bot's own texts are the bot's, anything else is yours", () => {
  const texts = [GREETING, ...SCRIPT, FOLLOW_UP];
  assert.equal(botAuthored(GREETING, texts), true);
  assert.equal(botAuthored(SCRIPT[0].replace("[ في {city}]", " في الرياض"), texts), true);
  assert.equal(botAuthored("مساء الخير بس أتأكد إن رسالتي وصلت", texts), true);
  assert.equal(botAuthored("تمام هبعتلك العرض دلوقتي", texts), false);
  assert.equal(botAuthored("", texts), false);
});

test("the SQL the bot writes to exists in the migration", () => {
  const sql = fs.readFileSync(new URL("../drizzle/migrations/0011_conversations.sql", import.meta.url), "utf8");
  for (const column of ["lead_id", "sender_id", "wa_id", "chat_phone", "author", "kind", "body", "auto", "sent_at"]) {
    assert.ok(sql.includes(`  ${column} `), `messages.${column}`);
  }
  assert.ok(sql.includes("UNIQUE (user_id, chat_phone, wa_id)"));
  assert.ok(sql.includes("manager_phone text"));
  assert.ok(sql.includes("manager_phone_at timestamptz"));
});
