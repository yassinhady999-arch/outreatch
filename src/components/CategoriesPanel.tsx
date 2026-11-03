import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";
import {
  addCategory,
  deleteCategory,
  updateCategory,
  type Category,
  type CategoryStats,
} from "@/lib/leads";

/** "all", "none" (uncategorized) or a category id. */
export type CategoryFilter = string;

const EMPTY: Omit<CategoryStats, "category_id"> = {
  total: 0,
  waiting: 0,
  pending: 0,
  sent: 0,
  no_whatsapp: 0,
};

/**
 * One card per category with its counts and an on/off switch. A stopped category's leads
 * are not distributed (see distribute_leads()). Clicking a card filters the client list.
 */
export function CategoriesPanel({
  categories,
  stats,
  unavailable,
  selected,
  onSelect,
}: {
  categories: Category[];
  stats: CategoryStats[];
  unavailable: boolean;
  selected: CategoryFilter;
  onSelect: (filter: CategoryFilter) => void;
}) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");

  const statsFor = (id: string | null) => stats.find((s) => s.category_id === id) ?? EMPTY;
  const sum = (key: keyof typeof EMPTY) => stats.reduce((n, s) => n + s[key], 0);
  const uncategorized = statsFor(null);

  const onError = (err: unknown) =>
    toast.error(
      err instanceof Error && err.message === "DUPLICATE" ? "يوجد فئة بنفس الاسم" : "تعذّر الحفظ",
    );

  const add = useMutation({
    mutationFn: () => addCategory(newName),
    onSuccess: () => {
      setNewName("");
      qc.invalidateQueries();
      toast.success("تمت إضافة الفئة");
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; active?: boolean } }) =>
      updateCategory(id, patch),
    onSuccess: (_d, { patch }) => {
      qc.invalidateQueries();
      if (patch.active === false) toast.success("أُوقفت الفئة — لن تُوزَّع أرقامها");
      if (patch.active === true) toast.success("فُعّلت الفئة — أرقامها رجعت للتوزيع");
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: deleteCategory,
    onSuccess: (_d, id) => {
      if (selected === id) onSelect("all");
      qc.invalidateQueries();
      toast.success("حُذفت الفئة");
    },
    onError,
  });

  if (unavailable)
    return (
      <section className="rise glass mt-6 rounded-2xl p-4 text-xs text-accent sm:p-5">
        الفئات تحتاج تشغيل ملف 0005_lead_categories.sql في Supabase.
      </section>
    );

  const card = (active: boolean) =>
    `cursor-pointer rounded-xl p-3 text-right ring-1 transition-colors ${
      active ? "bg-primary/5 ring-2 ring-primary" : "bg-card ring-border hover:bg-muted/40"
    }`;

  return (
    <section className="rise glass mt-6 rounded-2xl p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-6 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <div>
            <h3 className="text-base font-semibold text-foreground">الفئات</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              الفئة الموقوفة لا تُوزَّع أرقامها · اضغط على فئة لعرض عملائها
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) add.mutate();
          }}
          className="flex w-full items-center gap-2 sm:w-auto"
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="اسم فئة جديدة"
            className="min-w-0 flex-1 rounded-lg bg-input px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-ring sm:w-44"
          />
          <button
            type="submit"
            disabled={add.isPending || !newName.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            إضافة
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button onClick={() => onSelect("all")} className={card(selected === "all")}>
          <div className="text-sm font-semibold">كل الفئات</div>
          <div className="mt-2 text-2xl font-bold tabular-nums">{sum("total")}</div>
          <Counts waiting={sum("waiting")} pending={sum("pending")} sent={sum("sent")} />
        </button>

        {categories.map((c) => {
          const s = statsFor(c.id);
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => e.key === "Enter" && onSelect(c.id)}
              className={`${card(selected === c.id)} ${c.active ? "" : "opacity-75"}`}
            >
              <div className="text-sm font-semibold leading-snug break-words">{c.name}</div>
              <div className="mt-2 text-2xl font-bold tabular-nums">{s.total}</div>
              <Counts waiting={s.waiting} pending={s.pending} sent={s.sent} />
              {/* Own row so the name never gets cut off on a phone-width card */}
              <div className="mt-2 flex items-center justify-between gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    update.mutate({ id: c.id, patch: { active: !c.active } });
                  }}
                  disabled={update.isPending}
                  title={c.active ? "إيقاف توزيع هذه الفئة" : "تفعيل توزيع هذه الفئة"}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors disabled:opacity-60 ${
                    c.active
                      ? "bg-success text-success-foreground ring-success-foreground/30"
                      : "bg-accent/15 text-accent ring-accent/30"
                  }`}
                >
                  {c.active ? "مفعّلة ●" : "موقوفة ○"}
                </button>
                <span className="flex">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const name = window.prompt("اسم الفئة الجديد", c.name)?.trim();
                      if (name && name !== c.name) update.mutate({ id: c.id, patch: { name } });
                    }}
                    title="إعادة تسمية"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        window.confirm(
                          `حذف فئة «${c.name}»؟ أرقامها ستبقى موجودة بدون فئة وتُوزَّع عاديًا.`,
                        )
                      )
                        remove.mutate(c.id);
                    }}
                    title="حذف الفئة"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </span>
              </div>
            </div>
          );
        })}

        {uncategorized.total > 0 ? (
          <button onClick={() => onSelect("none")} className={card(selected === "none")}>
            <div className="text-sm font-semibold text-muted-foreground">بدون فئة</div>
            <div className="mt-2 text-2xl font-bold tabular-nums">{uncategorized.total}</div>
            <Counts
              waiting={uncategorized.waiting}
              pending={uncategorized.pending}
              sent={uncategorized.sent}
            />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Counts({ waiting, pending, sent }: { waiting: number; pending: number; sent: number }) {
  return (
    <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
      <div>
        في الانتظار <span className="tabular-nums text-foreground">{waiting}</span>
      </div>
      <div>
        مُسند لم يُرسل <span className="tabular-nums text-foreground">{pending}</span>
      </div>
      <div>
        أُرسل <span className="tabular-nums text-foreground">{sent}</span>
      </div>
    </div>
  );
}
