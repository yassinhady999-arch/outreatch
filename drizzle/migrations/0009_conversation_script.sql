-- The bot's conversation after the greeting (bot/script.mjs): each real reply from the
-- clinic gets the next message (1: who handles marketing, 2: may I send a message for them,
-- 3: the message for the doctor), and one follow-up goes out if nobody answers in 24 hours.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS city text,
  -- script messages sent after the greeting (0–3)
  ADD COLUMN IF NOT EXISTS step smallint NOT NULL DEFAULT 0,
  -- the bot's last message to this clinic (to tell an instant auto-reply from a real one)
  ADD COLUMN IF NOT EXISTS last_out_at timestamptz,
  -- the clinic's first reply that the bot hasn't answered yet
  ADD COLUMN IF NOT EXISTS reply_pending_at timestamptz,
  -- the «did my message arrive?» follow-up
  ADD COLUMN IF NOT EXISTS followed_up_at timestamptz;

-- Leads imported before the city was kept: their generated message names it
-- («… لعيادات الأسنان في الرياض عن طريق …»)
UPDATE public.leads
SET city = substring(message from 'لعيادات الأسنان في (.+?) عن طريق')
WHERE city IS NULL AND message IS NOT NULL;

-- Clinics already past the greeting under the old flow (they got their message) are done
UPDATE public.leads SET step = 3 WHERE step = 0 AND status NOT IN ('new', 'assigned');

CREATE INDEX IF NOT EXISTS leads_reply_pending_idx
  ON public.leads (reply_pending_at) WHERE reply_pending_at IS NOT NULL;

-- Clinics you already wrote to yourself (marked «اتبعت» from the site) are yours: the bot
-- sends them no script and no follow-up (step 99 = TAKEN_OVER in bot/core.mjs)
UPDATE public.leads SET step = 99
WHERE step = 0 AND id IN (SELECT lead_id FROM public.assignments WHERE sent);
