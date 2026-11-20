import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_SCHEDULE,
  GREETING,
  normalizePhone,
  parseSchedule,
  phoneCandidates,
  phoneToJid,
  planNextGreeting,
  cleanText,
  clinicCity,
  clinicName,
  fillTemplate,
  incomingAction,
  isAutoReply,
  isRefusal,
  manualMessageAction,
  messageText,
  parseHours,
  scriptMessage,
  TAKEN_OVER,
  waitingForGreeting,
  whatsappNumber,
  withinHours,
} from "./core.mjs";
import { FOLLOW_UP, SCRIPT } from "./script.mjs";

test("greeting is the same text the site's «التحية» button sends", () => {
  const app = fs.readFileSync(new URL("../src/lib/leads.ts", import.meta.url), "utf8");
  assert.ok(app.includes(`export const GREETING = "${GREETING}";`));
});

test("phone numbers become WhatsApp numbers like on the site", () => {
  assert.equal(whatsappNumber("+966555123730"), "966555123730");
  assert.equal(whatsappNumber("00966 55 512 3730"), "966555123730");
  assert.equal(whatsappNumber("01001234567"), "201001234567"); // Egyptian local form
  assert.equal(whatsappNumber("٠١٠٠١٢٣٤٥٦٧"), "201001234567"); // Arabic digits
  assert.equal(normalizePhone("+20 100-123 (4567)"), "+201001234567");
  assert.equal(phoneToJid("+966555123730"), "966555123730@s.whatsapp.net");
});

test("a reply's WhatsApp id finds the lead however its phone was saved", () => {
  assert.deepEqual(phoneCandidates("966555123730@s.whatsapp.net"), ["+966555123730", "966555123730"]);
  assert.deepEqual(phoneCandidates("201001234567:12@s.whatsapp.net"), [
    "+201001234567",
    "201001234567",
    "01001234567",
  ]);
});

test("sending hours: from is inclusive, to is exclusive", () => {
  const at = (h) => new Date(2026, 10, 12, h, 30);
  assert.equal(withinHours(at(8), 9, 21), false);
  assert.equal(withinHours(at(9), 9, 21), true);
  assert.equal(withinHours(at(20), 9, 21), true);
  assert.equal(withinHours(at(21), 9, 21), false);
});

test("only today's unsent, ungreeted, waiting clinics with WhatsApp get the greeting, oldest first", () => {
  const lead = (over) => ({ greeted_at: null, status: "assigned", no_whatsapp: false, ...over });
  const queue = waitingForGreeting([
    { id: "late", sent: false, created_at: "2026-11-12T10:00:00Z", leads: lead({}) },
    { id: "early", sent: false, created_at: "2026-11-12T08:00:00Z", leads: lead({}) },
    { id: "sent", sent: true, created_at: "2026-11-12T07:00:00Z", leads: lead({}) },
    { id: "greeted", sent: false, created_at: "2026-11-12T07:00:00Z", leads: lead({ greeted_at: "x" }) },
    { id: "noWa", sent: false, created_at: "2026-11-12T07:00:00Z", leads: lead({ no_whatsapp: true }) },
    { id: "contacted", sent: false, created_at: "2026-11-12T07:00:00Z", leads: lead({ status: "contacted" }) },
    { id: "noLead", sent: false, created_at: "2026-11-12T07:00:00Z", leads: null },
  ]);
  assert.deepEqual(
    queue.map((a) => a.id),
    ["early", "late"],
  );
});

test("schedule: 5 greetings in each of 9–12, 12–15, 15–19, 19–21", () => {
  assert.deepEqual(parseSchedule(DEFAULT_SCHEDULE), [
    { from: 9, to: 12, count: 5 },
    { from: 12, to: 15, count: 5 },
    { from: 15, to: 19, count: 5 },
    { from: 19, to: 21, count: 5 },
  ]);
  assert.throws(() => parseSchedule("9-12"), /جدول الإرسال غلط/);
});

test("planNextGreeting follows the windows, the per-window count and the gap", () => {
  const S = parseSchedule(DEFAULT_SCHEDULE);
  const day = (h, m = 0) => new Date(2026, 10, 12, h, m);
  const lead = (greetedAt) => ({ greeted_at: greetedAt ? greetedAt.toISOString() : null, status: "assigned", no_whatsapp: false });
  const waiting = (n) => Array.from({ length: n }, (_, i) => ({ id: "w" + i, sent: false, created_at: `2026-11-12T0${i}:00:00Z`, leads: lead(null) }));
  const greeted = (...times) => times.map((t, i) => ({ id: "g" + i, sent: false, created_at: "2026-11-12T00:00:00Z", leads: lead(t) }));
  const hm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

  let p = planNextGreeting(day(8, 10), S, waiting(3), 15);
  assert.equal(p.reason, "outside"); assert.equal(hm(p.waitUntil), "9:00");

  p = planNextGreeting(day(21, 30), S, waiting(3), 15);
  assert.equal(p.reason, "outside"); assert.equal(p.waitUntil.getDate(), 13); assert.equal(hm(p.waitUntil), "9:00");

  p = planNextGreeting(day(9, 5), S, waiting(3), 15);
  assert.equal(p.send?.id, "w0"); // first of the day goes out right away, oldest first

  const five = greeted(day(9, 0), day(9, 20), day(9, 40), day(10, 0), day(10, 20));
  p = planNextGreeting(day(10, 50), S, [...five, ...waiting(3)], 15);
  assert.equal(p.reason, "window-full"); assert.equal(hm(p.waitUntil), "12:00");

  // New window, but the last greeting (11:55) was less than 15 minutes ago
  const lastAt1155 = greeted(day(9, 0), day(11, 55));
  p = planNextGreeting(day(12, 5), S, [...lastAt1155, ...waiting(3)], 15);
  assert.equal(p.reason, "gap"); assert.equal(hm(p.waitUntil), "12:10");
  p = planNextGreeting(day(12, 10), S, [...lastAt1155, ...waiting(3)], 15);
  assert.equal(p.send?.id, "w0");

  p = planNextGreeting(day(19, 30), S, greeted(day(18, 0)), 15);
  assert.equal(p.reason, "none-left");

  // Yesterday's greetings don't count toward today's windows or gap
  const yesterday = greeted(new Date(2026, 10, 11, 9, 0), new Date(2026, 10, 11, 9, 20), new Date(2026, 10, 11, 9, 40), new Date(2026, 10, 11, 10, 0), new Date(2026, 10, 11, 10, 20));
  p = planNextGreeting(day(9, 1), S, [...yesterday, ...waiting(1)], 15);
  assert.equal(p.send?.id, "w0");
});

/* ---------- the conversation after the greeting ---------- */

const NL = String.fromCharCode(10);
// A message as the import tool wrote them (the Excel's «الرسالة المخصصة» column)
const importedMessage = [
  "السلام عليكم و رحمة الله",
  "",
  "أنا ياسين، متخصص في جلب مرضى لعيادات الأسنان في حفر الباطن عن طريق إعلانات تيك توك وسناب.",
  "",
  "عندي فكرة لزيادة المرضى في مجمع لمسة خبير لطب الأسنان، وحاب أعرضها على الدكتور أو مدير العيادة.",
].join(NL);

test("the clinic's name and city come from its data, else from its imported message", () => {
  const lead = { name: "Lamsa Khabeer Dental", city: null, message: importedMessage };
  assert.equal(clinicName(lead), "مجمع لمسة خبير لطب الأسنان"); // Arabic name from the message
  assert.equal(clinicCity(lead), "حفر الباطن");
  assert.equal(clinicCity({ ...lead, city: "الرياض" }), "الرياض"); // a saved city wins
  assert.equal(clinicName({ name: "نبراس لطب الأسنان", message: null }), "نبراس لطب الأسنان");
  assert.equal(clinicCity({ name: "x", message: null }), "");
  assert.equal(clinicName({}), "العيادة");
  // The clinic's own WhatsApp business name wins: the list paired this number with another clinic
  const wrong = { name: "Asnani Plus Dental Clinics", message: "عندي فكرة لزيادة المرضى في عيادات أسناني بلس، وحاب" };
  assert.equal(clinicName(wrong, "عيادات بصمة الابتسامة"), "عيادات بصمة الابتسامة");
  assert.equal(clinicName(wrong, undefined), "عيادات أسناني بلس"); // no business name: the data's
  const named = ["التسويق في {name}؟"]; // a script message that names the clinic
  assert.equal(scriptMessage(named, 1, wrong, "عيادات بصمة الابتسامة"), "التسويق في عيادات بصمة الابتسامة؟");
  assert.equal(scriptMessage(named, 1, wrong, "Dr. Smile 🦷"), "التسويق في Dr Smile؟"); // cleaned too
});

test("script messages are the texts from the picture, filled in for each clinic", () => {
  const lead = { name: "x", city: "الرياض", message: importedMessage };
  assert.equal(SCRIPT.length, 1); // one message: the manager's number
  assert.equal(
    scriptMessage(SCRIPT, 1, lead),
    ["الله يحييك عندك مانع تعطيني رقم الإدارة أو المدير؟", "عندي اقتراح عن إعلانات تيك توك وسناب لابتسامة هوليود في الرياض أريد رقم التواصل معه عشان أعرضها عليه"].join(NL),
  );
  assert.equal(scriptMessage(SCRIPT, 3, lead), null); // nothing after message 2
  assert.equal(cleanText(FOLLOW_UP), "مساء الخير بس أتأكد إن رسالتي وصلت");
});

test("without a city, the city parts are left out cleanly", () => {
  const lead = { name: "نبراس لطب الأسنان" };
  const withCity = ["لابتسامة هوليود[ في {city}] ممكن"];
  assert.equal(scriptMessage(withCity, 1, lead), "لابتسامة هوليود ممكن");
  assert.equal(scriptMessage(withCity, 1, { city: "جدة" }), "لابتسامة هوليود في جدة ممكن");
  assert.equal(fillTemplate("a[ b {x}] c {y}", { x: "", y: "Y" }), "a c Y");
  assert.equal(fillTemplate("a[ b {x}] c", { x: "X" }), "a b X c");
});

test("auto-replies are told apart from people", () => {
  // Business auto-replies
  assert.equal(isAutoReply("شكراً لتواصلك مع عيادات إيفا، سيتم الرد عليك في أقرب وقت", 600), true);
  assert.equal(isAutoReply("شكرا لتواصلكم معنا", 600), true);
  assert.equal(isAutoReply("نحن حالياً خارج أوقات الدوام", 600), true);
  assert.equal(isAutoReply("Thank you for contacting us. We will get back to you soon.", 600), true);
  assert.equal(
    isAutoReply("أهلاً وسهلاً بكم في مجمع تاج إيليت لطب الأسنان، أوقات العمل من 9 صباحاً حتى 11 مساءً، للحجز اضغط على الرابط", 600),
    true,
  );
  assert.equal(isAutoReply("وعليكم السلام", 3), true); // within seconds of our message: automatic
  // People
  assert.equal(isAutoReply("وعليكم السلام ورحمة الله", 120), false);
  assert.equal(isAutoReply("وعليكم السلام، أهلاً تفضل", 45), false); // short welcome by a person
  assert.equal(isAutoReply("الدكتور نفسه", 300), false);
  assert.equal(isAutoReply("", 300), false); // a voice note
  assert.equal(isAutoReply("تفضل", null), false); // time unknown
});

test("a clear no stops the conversation, a yes does not", () => {
  for (const no of ["مو مهتمين", "لا شكراً", "ما نحتاج", "مانبي", "غير مهتم الله يوفقك", "نعتذر منك", "عندنا شركة تسويق", "لا ترسل", "not interested"]) {
    assert.equal(isRefusal(no), true, no);
  }
  for (const yes of ["لا ما عندي مانع", "ما نمانع تفضل", "لا مانع", "تمام أرسل", "الدكتور غير موجود حالياً", "وعليكم السلام", "مو مشكلة أرسلها", ""]) {
    assert.equal(isRefusal(yes), false, yes);
  }
});

test("what the bot does with each message", () => {
  const lead = { greeted_at: "2026-11-14T09:00:00Z", status: "assigned", step: 0 };
  const n = 2; // a two-message script, to check the rules in the middle and at the end
  assert.equal(incomingAction(lead, "وعليكم السلام", 300, n), "reply");
  assert.equal(incomingAction({ ...lead, step: 1 }, "الدكتور نفسه", 300, n), "reply");
  assert.equal(incomingAction(lead, "شكراً لتواصلك، سيتم الرد عليك", 300, n), "auto");
  assert.equal(incomingAction(lead, "مو مهتمين", 300, n), "refusal");
  // After the last message a person takes over («متابعة»), unless it's a no or an auto-reply
  assert.equal(incomingAction({ ...lead, step: 2 }, "لا ما عندي مانع تفضل", 300, n), "after-script");
  assert.equal(incomingAction({ ...lead, step: 2 }, "لا شكراً", 300, n), "refusal");
  assert.equal(incomingAction({ ...lead, step: 2 }, "شكراً لتواصلك معنا", 300, n), "auto");
  assert.equal(incomingAction({ ...lead, step: 3, status: "replied" }, "تمام كلمني", 300, n), "after-script"); // old flow
  assert.equal(incomingAction({ ...lead, greeted_at: null }, "مرحبا", 300, n), "ignore"); // never greeted
  assert.equal(incomingAction({ ...lead, status: "not_interested" }, "مرحبا", 300, n), "ignore");
  assert.equal(incomingAction(null, "مرحبا", 300, n), "ignore"); // not one of ours
});

test("the text of an incoming WhatsApp message", () => {
  assert.equal(messageText({ conversation: "وعليكم السلام" }), "وعليكم السلام");
  assert.equal(messageText({ extendedTextMessage: { text: "تفضل" } }), "تفضل");
  assert.equal(messageText({ audioMessage: {}, messageContextInfo: {} }), ""); // a voice note
  assert.equal(messageText({ reactionMessage: { text: "👍" } }), "👍");
  assert.equal(messageText({ reactionMessage: { text: "" } }), null); // reaction removed
  assert.equal(messageText({ protocolMessage: {} }), null);
  assert.equal(messageText(null), null);
});

test("follow-up hours", () => {
  assert.deepEqual(parseHours("16-21"), { from: 16, to: 21 });
  assert.throws(() => parseHours("evening"));
});

test("a follow-up also delays the next greeting by the gap", () => {
  const sched = parseSchedule("9-12:5");
  const now = new Date(2026, 10, 14, 10, 0);
  const waiting = [{ id: "a", sent: false, created_at: "x", leads: { greeted_at: null, status: "assigned", no_whatsapp: false } }];
  assert.ok(planNextGreeting(now, sched, waiting, 15).send);
  const plan = planNextGreeting(now, sched, waiting, 15, new Date(2026, 10, 14, 9, 50));
  assert.equal(plan.reason, "gap");
  assert.equal(plan.waitUntil.getTime(), new Date(2026, 10, 14, 10, 5).getTime());
});

test("nothing the bot sends has emoji, periods, commas or colons — not even a clinic's name", () => {
  const lead = { name: "x", message: importedMessage.replace("مجمع لمسة خبير لطب الأسنان", "عيادة د. وائل الحساني 🦷, فرع: الملز") };
  const all = [1].map((step) => scriptMessage(SCRIPT, step, lead)).concat(cleanText(FOLLOW_UP));
  for (const text of all) {
    assert.doesNotMatch(text, /[.,،؛:]|\p{Extended_Pictographic}/u, text);
    assert.doesNotMatch(text, /  /, text); // no double spaces left behind
  }
  assert.equal(scriptMessage(["في {name}؟"], 1, lead), "في عيادة د وائل الحساني فرع الملز؟");
  assert.equal(cleanText("الله يحييك 🌷 سؤال"), "الله يحييك سؤال");
});

test("a message you write yourself: the greeting lets the bot carry on, anything else is yours", () => {
  const lead = { step: 0 };
  assert.equal(manualMessageAction(lead, GREETING), "greeting"); // the site's «التحية» button
  assert.equal(manualMessageAction(lead, "السلام عليكم ورحمة الله وبركاته"), "greeting");
  assert.equal(manualMessageAction(lead, "السلام عليكم"), "greeting");
  assert.equal(manualMessageAction(lead, "ليش حضرتك بتشوف الرسائل و مش بترد!"), "takeover");
  assert.equal(manualMessageAction(lead, importedMessage), "takeover"); // the long custom message
  assert.equal(manualMessageAction({ step: 1 }, "أهلين"), "takeover"); // mid-script
  assert.equal(manualMessageAction({ step: TAKEN_OVER }, "أهلين"), "ignore"); // already yours
  assert.equal(manualMessageAction(null, "أهلين"), "ignore"); // not a clinic
  // and a clinic you took over: its replies get «متابعة»
  // With the real one-message script, any reply to it means you take over
  const asked = { greeted_at: "2026-11-14T09:00:00Z", status: "replied", step: 1 };
  assert.equal(incomingAction(asked, "0551234567 رقم المدير", 300, SCRIPT.length), "after-script");
  assert.equal(incomingAction(asked, "ليش؟", 300, SCRIPT.length), "after-script");
  assert.equal(incomingAction(asked, "لا شكراً", 300, SCRIPT.length), "refusal");
  const yours = { greeted_at: "2026-11-14T09:00:00Z", status: "assigned", step: TAKEN_OVER };
  assert.equal(incomingAction(yours, "تمام", 300, SCRIPT.length), "after-script");
});
