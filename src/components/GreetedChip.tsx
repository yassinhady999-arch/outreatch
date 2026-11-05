/** Mark on the client's card that the greeting went out (time on hover). */
export function GreetedChip({ at }: { at: string }) {
  const when = new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
  return (
    <span
      title={`أُرسلت التحية ${when}`}
      className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/30"
    >
      تم إرسال التحية ✓
    </span>
  );
}
