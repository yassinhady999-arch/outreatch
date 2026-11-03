import { useState } from "react";
import { toast } from "sonner";
import { whatsappNumber } from "@/lib/leads";

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
 * Opens a chat with this number in the WhatsApp app or in WhatsApp Web. With a `message`,
 * both links prefill it and a copy button puts it on the clipboard (in case the prefill
 * doesn't show up). `onOpen` runs on the same click (e.g. to mark the message as sent).
 * The web button is hidden on touch devices, where WhatsApp Web doesn't work.
 */
export function WhatsAppButtons({
  phone,
  message,
  onOpen,
}: {
  phone: string;
  message?: string | null;
  onOpen?: () => void;
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
      <a
        href={`whatsapp://send?phone=${n}${text}`}
        onClick={onOpen}
        title="فتح المحادثة في تطبيق واتساب"
        className={green}
      >
        واتساب
      </a>
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
