-- When the opening greeting ("السلام عليكم و رحمة الله و بركاته") was sent to the lead.
-- Shown as a mark on the client's card; the clinic's own message is tracked separately
-- by assignments.sent.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS greeted_at timestamptz;
