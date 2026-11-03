import * as XLSX from "xlsx";
import { normalizePhone, type LeadImportRow } from "@/lib/leads";

const NAME_HEADER = /name|اسم/i;
const INSTA_HEADER = /insta|انستا|إنستا/i;
const MESSAGE_HEADER = /message|msg|رسال/i;
const CITY_HEADER = /city|مدين/i;

/** Only digits and phone punctuation (spaces, + - ( ) . and bidi marks), 6–15 digits. */
const isPhone = (v: string) =>
  /^[\s\d٠-٩۰-۹+\-().\u200e\u200f\u202a-\u202e]+$/.test(v) &&
  /^\+?\d{6,15}$/.test(normalizePhone(v));

const isInstagram = (v: string) => v.startsWith("@") || /instagram\.com/i.test(v);
/** A written message rather than a name: long or spanning several lines. */
const isLongText = (v: string) => v.length > 80 || v.includes("\n");
/** A row-number column (1, 2, 3…). */
const isIndex = (v: string) => /^\d{1,5}$/.test(v);

/**
 * Finds the phone column by content (the column holding the most phone numbers), so
 * column order doesn't matter. Name, Instagram and message come from header keywords when
 * the sheet has a header row, otherwise from content (a message is long or multi-line),
 * falling back to phone/name/instagram order. City and row-number columns are never the name.
 */
function parseRows(rows: string[][]): LeadImportRow[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cols = [...Array(width).keys()];
  const count = (c: number, test: (v: string) => boolean) =>
    rows.filter((r) => test(r[c] ?? "")).length;

  const phoneCol = cols.reduce(
    (best, c) => (count(c, isPhone) > count(best, isPhone) ? c : best),
    0,
  );
  if (width === 0 || count(phoneCol, isPhone) === 0) return [];

  const first = rows[0];
  const header = first && !isPhone(first[phoneCol] ?? "") ? first : null;
  const others = cols.filter(
    (c) => c !== phoneCol && rows.some((r) => (r[c] ?? "") !== "" && !isPhone(r[c] ?? "")),
  );
  const byHeader = (re: RegExp) =>
    header ? others.find((c) => re.test(header[c] ?? "")) : undefined;

  /** At least half of the column's filled cells pass the test. */
  const mostly = (c: number, test: (v: string) => boolean) => {
    const filled = rows.filter((r) => r !== header && (r[c] ?? "") !== "");
    return filled.length > 0 && filled.filter((r) => test(r[c] ?? "")).length * 2 >= filled.length;
  };

  const messageCol = byHeader(MESSAGE_HEADER) ?? others.find((c) => mostly(c, isLongText));
  const cityCol = byHeader(CITY_HEADER);
  let instaCol = byHeader(INSTA_HEADER) ?? others.find((c) => count(c, isInstagram) > 0);
  const candidates = others.filter(
    (c) => c !== messageCol && c !== cityCol && c !== instaCol && !mostly(c, isIndex),
  );
  // Searched among unclaimed columns, so e.g. "Instagram username" can't win the name
  const nameCol =
    (header ? candidates.find((c) => NAME_HEADER.test(header[c] ?? "")) : undefined) ??
    candidates[0];
  if (instaCol === undefined && !header) instaCol = candidates.find((c) => c !== nameCol);

  const get = (r: string[], c: number | undefined) => (c === undefined ? "" : (r[c] ?? ""));
  return rows
    .filter((r) => r !== header && isPhone(r[phoneCol] ?? ""))
    .map((r) => ({
      phone: get(r, phoneCol),
      name: get(r, nameCol),
      instagram: get(r, instaCol),
      message: get(r, messageCol),
    }));
}

/**
 * Some exporters drop the top bit of emoji, e.g. 🙏 (U+1F64F) saved as U+F64F, a private-use
 * character that shows as a box in WhatsApp. That private-use range (U+F300–U+FAFF, never
 * meaningful in this data) maps back onto the emoji block.
 */
const BROKEN_EMOJI = new RegExp(
  `[${String.fromCharCode(0xf300)}-${String.fromCharCode(0xfaff)}]`,
  "g",
);
const repairEmoji = (s: string) =>
  s.replace(BROKEN_EMOJI, (c) => String.fromCodePoint(c.charCodeAt(0) + 0x10000));

/** Reads the first sheet that contains phone numbers. Returns [] when none is found. */
export async function parseLeadsFile(file: File): Promise<LeadImportRow[]> {
  // raw: keep CSV cells as text so a leading "+" or "0" survives
  const wb = XLSX.read(await file.arrayBuffer(), { raw: true });
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
      .map((r) => r.map((v) => (v == null ? "" : repairEmoji(String(v).trim()))));
    const leads = parseRows(rows);
    if (leads.length > 0) return leads;
  }
  return [];
}
