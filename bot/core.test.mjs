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
  replyAction,
  waitingForGreeting,
  whatsappNumber,
  withinHours,
  withoutSalam,
} from "./core.mjs";

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

test("the clinic's message goes out once, only after the greeting", () => {
  const greeted = { id: "l", greeted_at: "2026-11-12T09:00:00Z", message: "رسالة العيادة" };
  assert.equal(replyAction(greeted, { id: "a", sent: false }), "send-message");
  assert.equal(replyAction(greeted, { id: "a", sent: true }), "ignore"); // already sent
  assert.equal(replyAction({ ...greeted, greeted_at: null }, { id: "a", sent: false }), "ignore"); // never greeted
  assert.equal(replyAction(null, null), "ignore"); // someone who isn't a lead
  assert.equal(replyAction(greeted, null), "ignore"); // not distributed
  assert.equal(replyAction({ ...greeted, message: "  " }, { id: "a", sent: false }), "no-message");
});

test("the clinic's message loses its salam line (the greeting already said it)", () => {
  const nl = String.fromCharCode(10);
  const msg = ["السلام عليكم و رحمة الله", "", "أنا ياسين، متخصص في جلب مرضى", "", "شاكر لك تعاونك 🙏"].join(nl);
  assert.equal(withoutSalam(msg), ["أنا ياسين، متخصص في جلب مرضى", "", "شاكر لك تعاونك 🙏"].join(nl));
  assert.equal(withoutSalam(["السلام عليكم ورحمة الله وبركاته", "عندي فكرة"].join(nl)), "عندي فكرة");
  assert.equal(withoutSalam("أنا ياسين"), "أنا ياسين"); // no salam: unchanged
  assert.equal(withoutSalam(null), "");
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
