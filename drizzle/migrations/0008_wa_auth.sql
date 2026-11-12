-- The bot's WhatsApp session (the linked-device keys), kept in the database so the bot can
-- run on a server whose disk is wiped on every restart (Render's free tier) without asking
-- for a new QR scan. One row per key, named like Baileys' session files (minus ".json"),
-- holding that file's exact text. Only the owner can read it: whoever holds these keys can
-- send from the linked number.

CREATE TABLE IF NOT EXISTS public.wa_auth (
  user_id uuid NOT NULL DEFAULT auth.uid(),
  session text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wa_auth TO authenticated;
GRANT ALL ON public.wa_auth TO service_role;
ALTER TABLE public.wa_auth ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own wa_auth select" ON public.wa_auth FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own wa_auth insert" ON public.wa_auth FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own wa_auth update" ON public.wa_auth FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own wa_auth delete" ON public.wa_auth FOR DELETE TO authenticated USING (auth.uid() = user_id);
