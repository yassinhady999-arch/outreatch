import { whatsappNumber } from "@/lib/leads";

const pill =
  "rounded-md bg-success px-2.5 py-1.5 text-xs font-medium text-success-foreground ring-1 ring-success-foreground/30 transition-colors hover:ring-success-foreground/60 sm:px-2 sm:py-0.5 sm:text-[11px]";

/**
 * Opens a chat with this number in the WhatsApp app or in WhatsApp Web. `onOpen` runs on
 * the same click (e.g. to mark the message as sent). The web button is hidden on touch
 * devices, where WhatsApp Web doesn't work and the app button is what you want.
 */
export function WhatsAppButtons({ phone, onOpen }: { phone: string; onOpen?: () => void }) {
  const n = whatsappNumber(phone);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <a
        href={`whatsapp://send?phone=${n}`}
        onClick={onOpen}
        title="فتح المحادثة في تطبيق واتساب"
        className={pill}
      >
        واتساب
      </a>
      {/* One named tab, reused on every click: WhatsApp Web won't run in two tabs at once */}
      <a
        href={`https://web.whatsapp.com/send?phone=${n}`}
        target="whatsapp-web"
        onClick={onOpen}
        title="فتح المحادثة في واتساب ويب"
        className={`${pill} pointer-coarse:hidden`}
      >
        ويب
      </a>
    </span>
  );
}
