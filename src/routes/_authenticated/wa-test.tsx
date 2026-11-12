import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { GREETING, fetchSenders, whatsappNumber } from "@/lib/leads";

export const Route = createFileRoute("/_authenticated/wa-test")({
  head: () => ({ meta: [{ title: "اختبار رسالة واتساب — مِرسال" }] }),
  component: WaTestPage,
});

// A real message from the dental clinics sheet (row 1)
const SAMPLE =
  "السلام عليكم و رحمة الله\n\nأنا ياسين، متخصص في جلب مرضى لعيادات الأسنان في الرياض عن طريق إعلانات تيك توك وسناب.\n\nعندي فكرة لزيادة المرضى في عيادة د. وائل الحساني، وحاب أعرضها على الدكتور أو مدير العيادة.\n\nممكن تفيدني برقمه؟\n\nشاكر لك تعاونك 🙏";

type Scheme = "api" | "wame" | "app" | "intent";

/**
 * Diagnostic: opens the same message in different shapes and link types, to find which one
 * Android WhatsApp drops the prefilled text for (the greeting works, the long message didn't).
 */
const VARIANTS: { key: string; label: string; text: string; scheme: Scheme }[] = [
  { key: "١", label: "التحية (قصيرة) — المفروض تشتغل", text: GREETING, scheme: "api" },
  { key: "٢", label: "الرسالة كاملة (زي زرار واتساب)", text: SAMPLE, scheme: "api" },
  { key: "٣", label: "كاملة من غير الإيموجي 🙏", text: SAMPLE.replace(" 🙏", ""), scheme: "api" },
  {
    key: "٤",
    label: "كاملة من غير السطور الفاضية",
    text: SAMPLE.split("\n\n").join("\n"),
    scheme: "api",
  },
  {
    key: "٥",
    label: "كاملة في سطر واحد",
    text: SAMPLE.split("\n\n").join(" "),
    scheme: "api",
  },
  {
    key: "٦",
    label: "أول سطرين بس (أقصر)",
    text: SAMPLE.split("\n\n").slice(0, 2).join("\n\n"),
    scheme: "api",
  },
  { key: "٧", label: "كاملة بلينك wa.me", text: SAMPLE, scheme: "wame" },
  { key: "٨", label: "كاملة بلينك whatsapp://", text: SAMPLE, scheme: "app" },
  { key: "٩", label: "كاملة بلينك أندرويد مباشر (intent)", text: SAMPLE, scheme: "intent" },
];

function href(scheme: Scheme, number: string, text: string) {
  const t = encodeURIComponent(text);
  switch (scheme) {
    case "api":
      return `https://api.whatsapp.com/send?phone=${number}&text=${t}`;
    case "wame":
      return `https://wa.me/${number}?text=${t}`;
    case "app":
      return `whatsapp://send?phone=${number}&text=${t}`;
    case "intent":
      return `intent://send/?phone=${number}&text=${t}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
  }
}

function WaTestPage() {
  const senders = useQuery({ queryKey: ["senders"], queryFn: fetchSenders });
  const [typed, setTyped] = useState<string | null>(null);
  // Default: your own sending number, so the test chat is "message yourself"
  const phone = typed ?? senders.data?.[0]?.phone ?? "";
  const number = whatsappNumber(phone);

  return (
    <AppShell>
      <section className="rise glass mt-6 space-y-4 rounded-2xl p-4 sm:p-5">
        <div>
          <h3 className="text-base font-semibold">اختبار رسالة واتساب</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            دوس كل زرار، وشوف الرسالة ظهرت مكتوبة في واتساب ولا الشات فتح فاضي. ما تبعتش حاجة، ارجع
            للصفحة دي وجرّب اللي بعده. وبعدين قولّي أرقام الزراير اللي الرسالة ظهرت فيها.
          </p>
        </div>
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          الرقم اللي هيتفتح (رقمك):
          <input
            dir="ltr"
            value={phone}
            onChange={(e) => setTyped(e.target.value)}
            className="num min-w-0 flex-1 rounded-lg bg-input px-3 py-2 text-sm text-foreground outline-none ring-1 ring-border"
          />
        </label>
        <div className="grid gap-2">
          {VARIANTS.map((v) => {
            const link = href(v.scheme, number, v.text);
            return (
              <a
                key={v.key}
                href={number ? link : undefined}
                target={v.scheme === "api" || v.scheme === "wame" ? "_blank" : undefined}
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 text-sm ring-1 ring-border transition-colors hover:bg-muted/40"
              >
                <span>
                  <span className="ml-2 font-bold text-primary">{v.key}</span>
                  {v.label}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {link.length} حرف
                </span>
              </a>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}
