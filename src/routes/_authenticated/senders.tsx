import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { addSender, deleteSender, fetchSenders, updateSender } from "@/lib/leads";

export const Route = createFileRoute("/_authenticated/senders")({
  head: () => ({
    meta: [
      { title: "أرقام الإرسال — مِرسال" },
      {
        name: "description",
        content: "أضف أرقام الإرسال وحدّد الحد اليومي لكل رقم لتوزيع العملاء بالتساوي.",
      },
      { property: "og:title", content: "أرقام الإرسال — مِرسال" },
      {
        property: "og:description",
        content: "أضف أرقام الإرسال وحدّد الحد اليومي لكل رقم لتوزيع العملاء بالتساوي.",
      },
    ],
  }),
  component: SendersPage,
});

function SendersPage() {
  const qc = useQueryClient();
  const senders = useQuery({ queryKey: ["senders"], queryFn: fetchSenders });

  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState(20);
  const [duplicate, setDuplicate] = useState(false);

  const add = useMutation({
    mutationFn: () => addSender({ phone, label, daily_limit: limit }),
    onSuccess: () => {
      setPhone("");
      setLabel("");
      setDuplicate(false);
      qc.invalidateQueries({ queryKey: ["senders"] });
      toast.success("تمت إضافة رقم الإرسال");
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "DUPLICATE") setDuplicate(true);
      else toast.error("تعذّرت الإضافة");
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { daily_limit?: number; active?: boolean } }) =>
      updateSender(id, patch),
    onSuccess: () => qc.invalidateQueries(),
    onError: () => toast.error("تعذّر الحفظ"),
  });

  const remove = useMutation({
    mutationFn: deleteSender,
    onSuccess: () => qc.invalidateQueries(),
    onError: () => toast.error("تعذّر الحذف"),
  });

  const rows = senders.data ?? [];
  const capacity = rows.filter((s) => s.active).reduce((sum, s) => sum + s.daily_limit, 0);

  return (
    <AppShell badge={`طاقة ${capacity} يوميًا`}>
      <section className="rise glass mt-6 rounded-2xl p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-muted-foreground">إضافة رقم إرسال</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setDuplicate(false);
            add.mutate();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            dir="ltr"
            required
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setDuplicate(false);
            }}
            placeholder="+966500000000"
            className="num min-w-[200px] flex-1 rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="وصف الرقم"
            className="w-40 rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">/ يوم</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="num w-16 rounded-md bg-input px-2 py-1.5 text-center text-sm outline-none ring-1 ring-border focus:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={add.isPending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            إضافة
          </button>
        </form>

        {duplicate ? (
          <div className="mt-2 rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
            هذا الرقم مضاف مسبقًا كرقم إرسال.
          </div>
        ) : null}

        <div className="mt-4 space-y-2 border-t border-border pt-4">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              لم تضف أرقام إرسال بعد. أضف رقمًا واحدًا على الأقل ليبدأ التوزيع.
            </p>
          ) : (
            rows.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-secondary px-3 py-2 ring-1 ring-border"
              >
                <div>
                  <div className="num text-sm" dir="ltr">
                    {s.phone}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{s.label || "رقم إرسال"}</div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={s.active}
                      onChange={(e) => update.mutate({ id: s.id, patch: { active: e.target.checked } })}
                      className="size-3.5 accent-primary"
                    />
                    مُفعّل
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">/ يوم</span>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      defaultValue={s.daily_limit}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== s.daily_limit) update.mutate({ id: s.id, patch: { daily_limit: v } });
                      }}
                      className="num w-16 rounded-md bg-input px-2 py-1 text-center text-sm outline-none ring-1 ring-border focus:ring-ring"
                    />
                  </div>
                  <button
                    onClick={() => remove.mutate(s.id)}
                    className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-accent"
                  >
                    حذف
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
