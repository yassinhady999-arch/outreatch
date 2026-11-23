import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, Pencil, Phone, Search } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { AppLink } from "@/components/WhatsAppButtons";
import { copyText } from "@/lib/clipboard";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  setLeadStatus,
  whatsappNumber,
  type LeadStatus,
} from "@/lib/leads";
import {
  fetchReplyLeads,
  fetchThread,
  fullTime,
  lastActivity,
  messageLabel,
  MissingSqlError,
  parsePhoneInput,
  samePhone,
  setManagerPhone,
  timeAgo,
  type ReplyLead,
  type ThreadMessage,
} from "@/lib/replies";

export const Route = createFileRoute("/_authenticated/replies")({
  head: () => ({
    meta: [
      { title: "الردود — مِرسال" },
      {
        name: "description",
        content:
          "العيادات اللي ردّت، آخر رسالة من كل عيادة، ورقم الإدارة اللي بعتته، والمحادثة كاملة.",
      },
      { property: "og:title", content: "الردود — مِرسال" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: RepliesPage,
});

type Filter = "follow_up" | "waiting" | "manager" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "follow_up", label: "متابعة" },
  { value: "waiting", label: "مستنية ردك" },
  { value: "manager", label: "معاها رقم إدارة" },
  { value: "all", label: "كل اللي ردّوا" },
];

/** The clinic wrote last (an auto-reply doesn't count) and is still open. */
const isWaiting = (l: ReplyLead) =>
  l.last_msg_author === "clinic" && l.status !== "not_interested" && l.status !== "closed";

const matches: Record<Filter, (l: ReplyLead) => boolean> = {
  follow_up: (l) => l.status === "follow_up",
  waiting: isWaiting,
  manager: (l) => !!l.manager_phone,
  all: () => true,
};

// No display class on the green links: AppLink renders one link for phones and one for computers
// and hides one of them with `hidden` / `pointer-coarse:hidden`, which a display class would undo
const pill =
  "rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors sm:px-2 sm:py-1 sm:text-[11px]";
const green = `${pill} bg-success text-success-foreground ring-success-foreground/30 hover:ring-success-foreground/60`;
const plainPill = `${pill} inline-flex items-center gap-1 bg-muted text-foreground ring-border hover:bg-muted/70`;

function RepliesPage() {
  const qc = useQueryClient();
  const leads = useQuery({
    queryKey: ["reply-leads"],
    queryFn: fetchReplyLeads,
    // New replies show up on their own while the page is open
    refetchInterval: 30_000,
    retry: (count, error) => !(error instanceof MissingSqlError) && count < 2,
  });
  const [filter, setFilter] = useState<Filter>("follow_up");
  const [query, setQuery] = useState("");

  const all = useMemo(() => leads.data ?? [], [leads.data]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.value, all.filter(matches[f.value]).length]),
      ) as Record<Filter, number>,
    [all],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return all.filter(
      (l) =>
        matches[filter](l) &&
        (!q ||
          (l.name ?? "").toLowerCase().includes(q) ||
          (l.city ?? "").toLowerCase().includes(q) ||
          (l.last_in_text ?? "").toLowerCase().includes(q) ||
          (digits.length >= 3 &&
            (whatsappNumber(l.phone).includes(digits) ||
              whatsappNumber(l.manager_phone ?? "").includes(digits)))),
    );
  }, [all, filter, query]);

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: LeadStatus }) => setLeadStatus(id, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reply-leads"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("اتغيّرت الحالة");
    },
    onError: () => toast.error("تعذّر تغيير الحالة"),
  });

  const changeManager = useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string | null }) => setManagerPhone(id, phone),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ["reply-leads"] });
      toast.success(v.phone ? "اتحفظ رقم الإدارة" : "اتشال رقم الإدارة");
    },
    onError: () => toast.error("تعذّر حفظ الرقم"),
  });

  const editManager = (l: ReplyLead) => {
    const typed = window.prompt("رقم الإدارة (سيبه فاضي عشان تشيله)", l.manager_phone ?? "");
    if (typed === null) return;
    const phone = parsePhoneInput(typed);
    if (phone === null) {
      toast.error("الرقم مش واضح — اكتبه زي 0501234567 أو ‎+966501234567");
      return;
    }
    changeManager.mutate({ id: l.id, phone: phone || null });
  };

  const missing = leads.error instanceof MissingSqlError;

  return (
    <AppShell {...(counts.waiting ? { badge: `${counts.waiting} مستنية ردك` } : {})}>
      <div className="rise mt-6">
        <h1 className="text-xl font-semibold">الردود</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          كل عيادة ردّت، وآخر رسالة منها، ورقم الإدارة لو بعتته. البوت بيسجّل المحادثة كاملة:
          رسايله، ورسايلك إنت، وردود العيادة.
        </p>
      </div>

      {missing ? (
        <div className="glass rise mt-4 rounded-2xl p-6 text-sm leading-relaxed">
          <p className="font-semibold text-accent">الصفحة دي محتاجة خطوة واحدة في Supabase.</p>
          <p className="mt-2 text-muted-foreground">
            افتح Supabase ← SQL Editor، والصق محتوى الملف{" "}
            <span dir="ltr" className="num font-medium text-foreground">
              drizzle/migrations/0011_conversations.sql
            </span>{" "}
            ودوس Run مرة واحدة. بعدها ارفع ملفات البوت الجديدة، والمحادثات هتبدأ تتسجّل.
          </p>
        </div>
      ) : (
        <>
          <div className="rise mt-4 flex flex-wrap items-center gap-2">
            <div className="glass inline-flex flex-wrap gap-1 rounded-xl p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  aria-pressed={filter === f.value}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm ${
                    filter === f.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f.label}{" "}
                  <span className="num tabular-nums opacity-80">{counts[f.value] ?? 0}</span>
                </button>
              ))}
            </div>
            <label className="relative min-w-[200px] flex-1">
              <span className="sr-only">بحث</span>
              <Search
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="دوّر بالاسم أو الرقم أو المدينة"
                className="w-full rounded-lg bg-input py-2 pr-9 pl-3 text-sm outline-none ring-1 ring-border focus:ring-ring"
              />
            </label>
          </div>

          {leads.isLoading ? (
            <div className="glass mt-4 rounded-2xl p-8 text-center text-sm text-muted-foreground">
              بنحمّل الردود…
            </div>
          ) : leads.error ? (
            <div className="glass mt-4 rounded-2xl p-8 text-center text-sm text-accent">
              تعذّر تحميل الردود. جرّب تاني بعد شوية.
            </div>
          ) : rows.length === 0 ? (
            <div className="glass mt-4 rounded-2xl p-8 text-center text-sm text-muted-foreground">
              {query
                ? "مفيش نتايج للبحث ده."
                : filter === "waiting"
                  ? "مفيش عيادة مستنية ردك دلوقتي."
                  : "مفيش عيادات هنا لسه."}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {rows.map((l) => (
                <ReplyCard
                  key={l.id}
                  lead={l}
                  onStatus={(status) => changeStatus.mutate({ id: l.id, status })}
                  onEditManager={() => editManager(l)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function ReplyCard({
  lead: l,
  onStatus,
  onEditManager,
}: {
  lead: ReplyLead;
  onStatus: (status: LeadStatus) => void;
  onEditManager: () => void;
}) {
  const [open, setOpen] = useState(false);
  const clinic = whatsappNumber(l.phone);
  const manager = l.manager_phone ? whatsappNumber(l.manager_phone) : null;
  const last = l.last_in_at ? messageLabel(l.last_in_kind, l.last_in_text) : null;

  const copy = async (text: string) => {
    if (await copyText(text)) toast.success("اتنسخ الرقم");
    else toast.error("تعذّر النسخ");
  };

  return (
    <article
      data-testid="reply-card"
      className="rise glass flex min-w-0 flex-col gap-3 rounded-2xl p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{l.name || l.phone}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {l.city ? <span>{l.city}</span> : null}
            <span className="num" dir="ltr">
              {l.phone}
            </span>
            {isWaiting(l) ? (
              <span className="rounded-md bg-warning px-2 py-0.5 text-[11px] font-medium text-warning-foreground">
                مستنية ردك
              </span>
            ) : null}
          </div>
        </div>
        <select
          value={l.status}
          onChange={(e) => onStatus(e.target.value as LeadStatus)}
          aria-label="حالة العيادة"
          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none ring-1 ring-border focus:ring-2 focus:ring-ring ${STATUS_TONE[l.status]}`}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-xl bg-muted/50 p-3 ring-1 ring-border">
        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>آخر رسالة منها</span>
          {lastActivity(l) ? (
            <span title={fullTime(lastActivity(l))}>
              {timeAgo(l.last_in_at ?? lastActivity(l))}
            </span>
          ) : null}
        </div>
        {last ? (
          <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-line">{last}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            ردّت قبل ما البوت يبدأ يسجّل المحادثات — هتظهر هنا أول ما تكتب تاني.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">رقم الإدارة</span>
        {manager ? (
          <>
            <span className="num text-sm font-semibold" dir="ltr" data-testid="manager-phone">
              {l.manager_phone}
            </span>
            <AppLink
              number={manager}
              text={null}
              title="فتح محادثة رقم الإدارة في واتساب"
              className={green}
            >
              واتساب الإدارة
            </AppLink>
            <a
              href={`https://web.whatsapp.com/send?phone=${manager}`}
              target="whatsapp-web"
              title="فتح محادثة رقم الإدارة في واتساب ويب"
              className={`${green} pointer-coarse:hidden`}
            >
              ويب
            </a>
            <a href={`tel:+${manager}`} title="اتصال برقم الإدارة" className={plainPill}>
              <Phone className="size-3.5" aria-hidden /> اتصال
            </a>
            <button
              type="button"
              onClick={() => copy(l.manager_phone ?? "")}
              title="نسخ رقم الإدارة"
              className={plainPill}
            >
              <Copy className="size-3.5" aria-hidden /> نسخ
            </button>
            <button
              type="button"
              onClick={onEditManager}
              title="تعديل رقم الإدارة"
              className={plainPill}
            >
              <Pencil className="size-3.5" aria-hidden /> تعديل
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">لسه ما بعتتهوش</span>
            <button type="button" onClick={onEditManager} className={plainPill}>
              <Pencil className="size-3.5" aria-hidden /> إضافة رقم
            </button>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="flex flex-wrap items-center gap-1">
          <AppLink
            number={clinic}
            text={null}
            title="فتح محادثة العيادة في واتساب"
            className={green}
          >
            واتساب العيادة
          </AppLink>
          <a
            href={`https://web.whatsapp.com/send?phone=${clinic}`}
            target="whatsapp-web"
            title="فتح محادثة العيادة في واتساب ويب"
            className={`${green} pointer-coarse:hidden`}
          >
            ويب
          </a>
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
        >
          المحادثة
          <ChevronDown
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
      </div>

      {open ? <Thread lead={l} /> : null}
    </article>
  );
}

const AUTHOR_LABEL: Record<string, string> = { bot: "البوت", me: "إنت", clinic: "العيادة" };

function Thread({ lead }: { lead: ReplyLead }) {
  const thread = useQuery({
    queryKey: ["thread", lead.id],
    queryFn: () => fetchThread(lead.id),
    refetchInterval: 30_000,
  });
  const box = useRef<HTMLDivElement>(null);
  const count = thread.data?.length ?? 0;
  useEffect(() => {
    // Open at the latest message, like WhatsApp
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count]);

  if (thread.isLoading) return <p className="text-xs text-muted-foreground">بنحمّل المحادثة…</p>;
  if (thread.error) return <p className="text-xs text-accent">تعذّر تحميل المحادثة.</p>;
  if (!count)
    return (
      <p className="text-xs text-muted-foreground">
        مفيش رسايل متسجلة للعيادة دي لسه. البوت بيسجّل من أول ما اتحدّث، وأول ما حد يكتب في المحادثة
        بيطلب الرسايل القديمة من الموبايل.
      </p>
    );

  const who = (m: ThreadMessage) => {
    if (m.author !== "clinic") return AUTHOR_LABEL[m.author] ?? m.author;
    return samePhone(m.chat_phone, lead.manager_phone) && !samePhone(m.chat_phone, lead.phone)
      ? "الإدارة"
      : "العيادة";
  };

  return (
    <div
      ref={box}
      data-testid="thread"
      className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto rounded-xl bg-background/60 p-3 ring-1 ring-border"
    >
      {(thread.data ?? []).map((m) => {
        const theirs = m.author === "clinic";
        const toManager =
          !theirs &&
          samePhone(m.chat_phone, lead.manager_phone) &&
          !samePhone(m.chat_phone, lead.phone);
        return (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              theirs
                ? `self-start bg-card ring-1 ring-border ${m.auto ? "opacity-70" : ""}`
                : m.author === "bot"
                  ? "self-end bg-primary/10"
                  : "self-end bg-success text-success-foreground"
            }`}
          >
            <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[10px] opacity-75">
              <span className="font-semibold">
                {who(m)}
                {toManager ? " ← الإدارة" : ""}
              </span>
              {m.auto ? <span className="rounded bg-muted px-1">رد آلي</span> : null}
              <span title={fullTime(m.sent_at)}>{fullTime(m.sent_at)}</span>
            </div>
            <p className="break-words whitespace-pre-line">{messageLabel(m.kind, m.body)}</p>
          </div>
        );
      })}
    </div>
  );
}
