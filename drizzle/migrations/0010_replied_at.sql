-- When the clinic first answered for real (an auto-reply doesn't count): the bot sets it,
-- and the analytics page measures response time from the greeting with it.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS replied_at timestamptz;

-- Replies the bot already answered: its message went out 3 minutes after the reply
-- (REPLY_DELAY_MINUTES), and last_out_at still holds that message's time
UPDATE public.leads
SET replied_at = last_out_at - interval '3 minutes'
WHERE replied_at IS NULL
  AND last_out_at IS NOT NULL
  AND step BETWEEN 1 AND 98
  AND status IN ('contacted', 'replied', 'follow_up', 'interested', 'not_interested', 'closed');
