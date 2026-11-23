-- The conversations with the clinics, kept in the database (page «الردود»):
-- every WhatsApp message between a sending number and a clinic — or the management
-- number the clinic gave — whoever wrote it: the bot, you (phone / WhatsApp Web), or them.
-- Only chats with numbers on the clients list are kept; other chats on the phone are not.

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  -- the sending number whose WhatsApp the message went through
  sender_id uuid REFERENCES public.senders(id) ON DELETE SET NULL,
  -- WhatsApp's own id of the message: the same message is never saved twice
  wa_id text NOT NULL,
  -- the other side of the chat: the clinic's number, or its management's
  chat_phone text NOT NULL,
  -- clinic: they wrote it · bot: the bot sent it · me: you wrote it yourself
  author text NOT NULL CHECK (author IN ('clinic', 'bot', 'me')),
  -- text · image · video · voice · audio · document · sticker · contact · location · reaction · poll · other
  kind text NOT NULL DEFAULT 'text',
  -- the text, or a picture's / file's caption ('' for a voice note)
  body text NOT NULL DEFAULT '',
  -- a WhatsApp Business auto-reply, not a person
  auto boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, chat_phone, wa_id)
);

CREATE INDEX IF NOT EXISTS messages_lead_idx ON public.messages (lead_id, sent_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own messages select" ON public.messages;
DROP POLICY IF EXISTS "own messages insert" ON public.messages;
DROP POLICY IF EXISTS "own messages update" ON public.messages;
DROP POLICY IF EXISTS "own messages delete" ON public.messages;
CREATE POLICY "own messages select" ON public.messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own messages insert" ON public.messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own messages update" ON public.messages FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own messages delete" ON public.messages FOR DELETE TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.leads
  -- the management's / manager's number the clinic sent (the bot picks it out of the reply;
  -- the «الردود» page can change it)
  ADD COLUMN IF NOT EXISTS manager_phone text,
  ADD COLUMN IF NOT EXISTS manager_phone_at timestamptz,
  -- the clinic's last real message (auto-replies don't count), for the «الردود» page
  ADD COLUMN IF NOT EXISTS last_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_in_text text,
  ADD COLUMN IF NOT EXISTS last_in_kind text,
  -- the chat's last message and who wrote it: 'clinic' = they are waiting for an answer
  ADD COLUMN IF NOT EXISTS last_msg_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_msg_author text;

CREATE INDEX IF NOT EXISTS leads_manager_phone_idx
  ON public.leads (manager_phone) WHERE manager_phone IS NOT NULL;

-- Each saved message moves the clinic's «last message» forward (older messages arriving
-- later, e.g. an old conversation fetched from the phone, never move it back). Auto-replies
-- and reactions (👍 on a message) don't count as a message waiting for an answer.
CREATE OR REPLACE FUNCTION public.messages_touch_lead()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.author = 'clinic' AND NEW.auto) OR NEW.kind = 'reaction' THEN
    RETURN NULL;
  END IF;
  UPDATE public.leads SET
    last_msg_author = CASE WHEN last_msg_at IS NULL OR NEW.sent_at >= last_msg_at THEN NEW.author ELSE last_msg_author END,
    last_msg_at = GREATEST(COALESCE(last_msg_at, NEW.sent_at), NEW.sent_at),
    last_in_text = CASE WHEN NEW.author = 'clinic' AND (last_in_at IS NULL OR NEW.sent_at >= last_in_at) THEN left(NEW.body, 500) ELSE last_in_text END,
    last_in_kind = CASE WHEN NEW.author = 'clinic' AND (last_in_at IS NULL OR NEW.sent_at >= last_in_at) THEN NEW.kind ELSE last_in_kind END,
    last_in_at = CASE WHEN NEW.author = 'clinic' AND (last_in_at IS NULL OR NEW.sent_at >= last_in_at) THEN NEW.sent_at ELSE last_in_at END
  WHERE id = NEW.lead_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS messages_touch_lead ON public.messages;
CREATE TRIGGER messages_touch_lead
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_touch_lead();
