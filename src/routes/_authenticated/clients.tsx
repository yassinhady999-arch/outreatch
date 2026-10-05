import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { WhatsAppButtons } from "@/components/WhatsAppButtons";
import { parseLeadsFile } from "@/lib/import-leads";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  addLead,
  addLeadsBulk,
  countryFromPhone,
  deleteLead,
  fetchLeads,
  markLeadSent,
  normalizePhone,
  setLeadNoWhatsapp,
  setLeadStatus,
  type LeadStatus,
} from "@/lib/leads";

type ClientsFilter = LeadStatus | "all" | "no_wa";

export const Route = createFileRoute("/_authenticated/clients")({
  head: () => ({
    meta: [
      { title: "أرقام العملاء — مِرسال" },
      {
        name: "description",
        content: "أضف أرقام العملاء ومنع التكرار تلقائيًا، وتابع حالة كل عميل في مسار المتابعة.",
      },
      { property: "og:title", content: "أرقام العملاء — مِرسال" },
      {
        property: "og:description",
        content: "أضف أرقام العملاء ومنع التكرار تلقائيًا، وتابع حالة كل عميل في مسار المتابعة.",
      },
    ],
  }),
  component: ClientsPage,
});

function ClientsPage() {
  const qc = useQueryClient();
  const leads = useQuery({ queryKey: ["leads"], queryFn: fetchLeads });

  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClientsFilter>("all");
  const fileRef = useRef<HTMLInputElement>(null);

  const importFile = useMutation({
    mutationFn: async (file: File) => addLeadsBulk(await parseLeadsFile(file)),
    onSuccess: ({ added, skipped, invalid }) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      if (added > 0) toast.success(`تم استيراد ${added} عميل`);
      if (skipped > 0) toast.info(`تم تخطي ${skipped} رقم مكرر`);
      if (invalid > 0) toast.info(`تم تجاهل ${invalid} صف بلا رقم صالح`);
      if (added === 0 && skipped === 0 && invalid === 0)
        toast.error("لم نجد أرقام هواتف في الملف — تأكد أن فيه عمودًا للأرقام");
    },
    onError: () => toast.error("تعذّر قراءة الملف — تأكد أنه ملف إكسل أو CSV"),
  });

  const add = useMutation({
    mutationFn: () => addLead({ phone, name, country: countryFromPhone(normalizePhone(phone)) }),
    onSuccess: () => {
      setPhone("");
      setName("");
      setDuplicate(null);
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("تمت إضافة العميل");
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "DUPLICATE") {
        setDuplicate(normalizePhone(phone));
      } else {
        toast.error("تعذّرت الإضافة");
      }
    },
  });

  const remove = useMutation({
    mutationFn: deleteLead,
    onSuccess: () => qc.invalidateQueries(),
    onError: () => toast.error("تعذّر الحذف"),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) => setLeadStatus(id, status),
    onSuccess: () => qc.invalidateQueries(),
    onError: () => toast.error("تعذّر تحديث الحالة"),
  });

  const toggleNoWhatsapp = useMutation({
    mutationFn: ({ id, noWhatsapp }: { id: string; noWhatsapp: boolean }) =>
      setLeadNoWhatsapp(id, noWhatsapp),
    onSuccess: () => qc.invalidateQueries(),
    onError: () => toast.error("تعذّر تحديث الحالة"),
  });

  // Opening WhatsApp counts as sending; retry in case leaving the page cut the request off
  const markSentFromWhatsapp = useMutation({
    mutationFn: markLeadSent,
    retry: 3,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assignments"] }),
  });

  const all = leads.data ?? [];
  const noWaCount = all.filter((l) => l.no_whatsapp).length;
  const rows = all.filter((l) =>
    filter === "all" ? true : filter === "no_wa" ? l.no_whatsapp : l.status === filter,
  );
  const countFor = (s: ClientsFilter) =>
    s === "all" ? all.length : s === "no_wa" ? noWaCount : all.filter((l) => l.status === s).length;

  return (
    <AppShell badge={`${all.length} عميل`}>
      <section className="rise glass mt-6 overflow-hidden rounded-2xl">
        {/* ============ إضافة عميل ============ */}
        <div className="p-4 pb-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-6 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              <div>
                <h3 className="text-base font-semibold text-foreground">إضافة عميل جديد</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  يُوزَّع العميل تلقائيًا على أرقام الإرسال المفعّلة حسب الحد اليومي
                </p>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFile.mutate(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={importFile.isPending}
              className="flex items-center gap-2 rounded-xl bg-muted px-4 py-2.5 text-xs font-medium text-foreground ring-1 ring-border transition-colors hover:bg-muted/70 disabled:opacity-60"
            >
              <FileUp className="size-4 opacity-70" aria-hidden />
              {importFile.isPending ? "جارٍ الاستيراد…" : "استيراد من إكسل"}
            </button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setDuplicate(null);
              add.mutate();
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <div className="flex min-w-[260px] flex-1 items-center rounded-xl bg-input ring-1 ring-border transition-shadow focus-within:ring-2 focus-within:ring-ring">
              <input
                dir="ltr"
                required
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setDuplicate(null);
                }}
                placeholder="+966500000000"
                className="num min-w-0 flex-[3] bg-transparent px-4 py-3 text-sm outline-none"
              />
              <span className="h-6 w-px shrink-0 bg-border" aria-hidden />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="اسم العميل"
                className="min-w-0 flex-[2] bg-transparent px-4 py-3 text-sm outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={add.isPending}
              className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-60"
            >
              إضافة
            </button>
          </form>

          {duplicate ? (
            <div className="mt-2 rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
              الرقم <span className="num">{duplicate}</span> موجود مسبقًا في القائمة — لا يمكن تكراره.
            </div>
          ) : null}
        </div>

        {/* ============ فلترة الحالات ============ */}
        <div className="flex flex-wrap gap-1.5 border-y border-border bg-muted/30 px-5 py-3">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={countFor("all")}>
            الكل
          </FilterChip>
          {STATUS_ORDER.map((s) => (
            <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)} count={countFor(s)}>
              {STATUS_LABEL[s]}
            </FilterChip>
          ))}
          <FilterChip active={filter === "no_wa"} onClick={() => setFilter("no_wa")} count={noWaCount}>
            بدون واتساب
          </FilterChip>
        </div>

        {/* ============ قائمة العملاء ============ */}
        {/* Below md each row becomes a stacked card (CSS grid), so every column stays reachable */}
        <div className="p-3 pt-2 sm:p-5 sm:pt-2 md:overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-right max-md:block">
            <thead className="max-md:hidden">
              <tr className="text-[11px] font-medium text-muted-foreground">
                <th className="px-4 pb-1 text-right">رقم الهاتف</th>
                <th className="px-4 pb-1 text-right">العميل</th>
                <th className="px-4 pb-1 text-right">الحالة</th>
                <th className="px-4 pb-1 text-center">تحديث الحالة</th>
                <th className="px-4 pb-1 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="max-md:block max-md:space-y-2">
              {rows.length === 0 ? (
                <tr className="max-md:block">
                  <td
                    colSpan={5}
                    className="py-8 text-center text-sm text-muted-foreground max-md:block"
                  >
                    لا أرقام في هذه القائمة.
                  </td>
                </tr>
              ) : (
                rows.map((l) => (
                  <tr
                    key={l.id}
                    className="bg-card transition-colors hover:bg-muted/40 max-md:grid max-md:grid-cols-[1fr_auto] max-md:items-center max-md:gap-2 max-md:rounded-xl max-md:border max-md:border-border max-md:p-3"
                  >
                    <td className="border-border max-md:order-2 max-md:col-span-2 md:rounded-r-xl md:border-y md:border-r md:px-4 md:py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 md:justify-start">
                        <span className="num text-sm" dir="ltr">
                          {l.phone}
                        </span>
                        {l.no_whatsapp ? null : (
                          <WhatsAppButtons
                            phone={l.phone}
                            onOpen={() => markSentFromWhatsapp.mutate(l.id)}
                          />
                        )}
                      </div>
                    </td>
                    <td className="border-border max-md:order-1 max-md:col-span-2 md:border-y md:px-4 md:py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-semibold text-foreground">{l.name || "—"}</span>
                        {l.instagram ? (
                          <a
                            href={l.instagram}
                            target="_blank"
                            rel="noreferrer"
                            className="w-fit text-[11px] text-primary underline underline-offset-2"
                          >
                            إنستجرام
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td className="border-border max-md:order-3 max-md:col-span-2 md:border-y md:px-4 md:py-3">
                      <span className={`inline-block rounded-lg px-2.5 py-1 text-[11px] font-medium ${STATUS_TONE[l.status]}`}>
                        {STATUS_LABEL[l.status]}
                      </span>
                      {l.no_whatsapp ? (
                        <span className="mr-2 inline-block rounded-lg bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent ring-1 ring-accent/30">
                          بدون واتساب
                        </span>
                      ) : null}
                      {l.country ? (
                        <span className="mr-2 text-[11px] text-muted-foreground">{l.country}</span>
                      ) : null}
                    </td>
                    <td className="border-border max-md:order-4 md:border-y md:px-4 md:py-3 md:text-center">
                      <select
                        value={l.status}
                        onChange={(e) =>
                          changeStatus.mutate({ id: l.id, status: e.target.value as LeadStatus })
                        }
                        className="rounded-lg bg-input px-2.5 py-1.5 text-xs outline-none ring-1 ring-border focus:ring-2 focus:ring-ring max-md:w-full max-md:py-2"
                      >
                        {STATUS_ORDER.map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="border-border max-md:order-5 md:rounded-l-xl md:border-y md:border-l md:px-4 md:py-3 md:text-center">
                      <div className="flex items-center justify-end gap-1 md:justify-center">
                        <button
                          onClick={() => toggleNoWhatsapp.mutate({ id: l.id, noWhatsapp: !l.no_whatsapp })}
                          title={l.no_whatsapp ? "إعادة الرقم إلى واتساب" : "الرقم ليس لديه واتساب"}
                          className={`rounded-lg px-2 py-1.5 text-[11px] ring-1 transition-colors max-md:py-2 ${
                            l.no_whatsapp
                              ? "bg-accent/15 text-accent ring-accent/30"
                              : "text-muted-foreground ring-border hover:text-foreground"
                          }`}
                        >
                          {l.no_whatsapp ? "بدون واتساب ✕" : "بدون واتساب؟"}
                        </button>
                        <button
                          onClick={() => remove.mutate(l.id)}
                          title="حذف"
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent max-md:p-2"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ============ ملخص ============ */}
        <div className="border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            إجمالي العملاء: <span className="font-semibold text-primary">{all.length}</span>
            {filter !== "all" ? (
              <>
                {" "}— معروض حاليًا: <span className="font-semibold text-foreground">{rows.length}</span>
              </>
            ) : null}
          </p>
        </div>
      </section>
    </AppShell>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground ring-1 ring-border hover:text-foreground"
      }`}
    >
      {children}
      <span
        className={`num rounded-full px-1.5 text-[10px] ${
          active ? "bg-primary-foreground/20" : "bg-muted"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
