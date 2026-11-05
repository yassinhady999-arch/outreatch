import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { GREETING, whatsappNumber } from "@/lib/leads";

const pill =
  "rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors sm:px-2 sm:py-0.5 sm:text-[11px]";
const green = `${pill} bg-success text-success-foreground ring-success-foreground/30 hover:ring-success-foreground/60`;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs https or localhost; fall back when opened over plain http (LAN)
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/**
 * Opens the WhatsApp app on this number with `text` typed in, ready to send. Phones get
 * WhatsApp's official click-to-chat link (wa.me), which keeps the text; some phones open the
 * unofficial whatsapp:// link without it. Computers keep whatsapp:// (straight into the
 * desktop app). Both links are rendered and CSS shows the one for the device.
 */
function AppLink({
  number,
  text,
  onClick,
  title,
  className,
  children,
}: {
  number: string;
  text: string | null | undefined;
  onClick?: (() => void) | undefined;
  title: string;
  className: string;
  children: ReactNode;
}) {
  const encoded = text ? encodeURIComponent(text) : "";
  return (
    <>
      <a
        href={`https://wa.me/${number}${encoded ? `?text=${encoded}` : ""}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        title={title}
        className={`${className} hidden pointer-coarse:inline-block`}
      >
        {children}
      </a>
      <a
        href={`whatsapp://send?phone=${number}${encoded ? `&text=${encoded}` : ""}`}
        onClick={onClick}
        title={title}
        className={`${className} pointer-coarse:hidden`}
      >
        {children}
      </a>
    </>
  );
}

/**
 * Opens a chat with this number in the WhatsApp app or in WhatsApp Web, with `message`
 * typed in. A copy button puts the message on the clipboard as a fallback. `onOpen` runs on
 * the same click (e.g. to mark the message as sent).
 *
 * With `onGreet`, a «التحية» button first opens the chat with just the greeting (GREETING)
 * typed in; `greeted` shows that it already went out.
 */
export function WhatsAppButtons({
  phone,
  message,
  onOpen,
  onGreet,
  greeted = false,
}: {
  phone: string;
  message?: string | null;
  onOpen?: () => void;
  onGreet?: () => void;
  greeted?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const n = whatsappNumber(phone);
  const text = message ? `&text=${encodeURIComponent(message)}` : "";

  const copy = async () => {
    if (!message) return;
    if (await copyText(message)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("تم نسخ الرسالة");
    } else {
      toast.error("تعذّر النسخ");
    }
  };

  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1">
      {onGreet ? (
        <AppLink
          number={n}
          text={GREETING}
          onClick={onGreet}
          title={`إرسال التحية: ${GREETING}`}
          className={`${pill} ${
            greeted
              ? "bg-primary/10 text-primary ring-primary/30"
              : "bg-info text-info-foreground ring-info-foreground/30 hover:ring-info-foreground/60"
          }`}
        >
          {greeted ? "التحية ✓" : "التحية"}
        </AppLink>
      ) : null}
      {message ? (
        <button
          type="button"
          onClick={copy}
          title={message}
          className={`${pill} ${
            copied
              ? "bg-primary/10 text-primary ring-primary/30"
              : "bg-muted text-foreground ring-border hover:bg-muted/70"
          }`}
        >
          {copied ? "تم النسخ ✓" : "نسخ الرسالة"}
        </button>
      ) : null}
      <AppLink
        number={n}
        text={message}
        onClick={onOpen}
        title="فتح المحادثة في تطبيق واتساب"
        className={green}
      >
        واتساب
      </AppLink>
      {/* One named tab, reused on every click: WhatsApp Web won't run in two tabs at once */}
      <a
        href={`https://web.whatsapp.com/send?phone=${n}${text}`}
        target="whatsapp-web"
        onClick={onOpen}
        title="فتح المحادثة في واتساب ويب"
        className={`${green} pointer-coarse:hidden`}
      >
        ويب
      </a>
    </span>
  );
}
