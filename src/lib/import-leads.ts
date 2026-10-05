import * as XLSX from "xlsx";
import { normalizePhone, type LeadImportRow } from "@/lib/leads";

const NAME_HEADER = /name|اسم/i;
const INSTA_HEADER = /insta|انستا|إنستا/i;

/** Only digits and phone punctuation (spaces, + - ( ) . and bidi marks), 6–15 digits. */
const isPhone = (v: string) =>
  /^[\s\d٠-٩۰-۹+\-().\u200e\u200f\u202a-\u202e]+$/.test(v) &&
  /^\+?\d{6,15}$/.test(normalizePhone(v));

const isInstagram = (v: string) => v.startsWith("@") || /instagram\.com/i.test(v);

/**
 * Finds the phone column by content (the column holding the most phone numbers), so
 * column order doesn't matter. Name and Instagram come from header keywords when the
 * sheet has a header row, otherwise from content, falling back to phone/name/instagram order.
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

  let instaCol = byHeader(INSTA_HEADER) ?? others.find((c) => count(c, isInstagram) > 0);
  const nameCol = byHeader(NAME_HEADER) ?? others.find((c) => c !== instaCol);
  if (instaCol === undefined && !header) instaCol = others.find((c) => c !== nameCol);

  const get = (r: string[], c: number | undefined) => (c === undefined ? "" : (r[c] ?? ""));
  return rows
    .filter((r) => r !== header && isPhone(r[phoneCol] ?? ""))
    .map((r) => ({ phone: get(r, phoneCol), name: get(r, nameCol), instagram: get(r, instaCol) }));
}

/** Reads the first sheet that contains phone numbers. Returns [] when none is found. */
export async function parseLeadsFile(file: File): Promise<LeadImportRow[]> {
  // raw: keep CSV cells as text so a leading "+" or "0" survives
  const wb = XLSX.read(await file.arrayBuffer(), { raw: true });
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils
      .sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
      .map((r) => r.map((v) => (v == null ? "" : String(v).trim())));
    const leads = parseRows(rows);
    if (leads.length > 0) return leads;
  }
  return [];
}
