-- Lead categories (e.g. medical complexes, dental clinics), each with an on/off switch,
-- and a per-lead outreach message (imported from Excel, copied/prefilled when sending).
--
-- Categories:
-- A stopped category's leads stay in the system but aren't distributed or forecast, and
-- their unsent assignments go back to the pool so active categories fill the capacity.
-- Leads without a category are treated as active.

CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories TO authenticated;
GRANT ALL ON public.categories TO service_role;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own categories select" ON public.categories FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own categories insert" ON public.categories FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own categories update" ON public.categories FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own categories delete" ON public.categories FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Personal outreach message for the lead (e.g. one written per clinic)
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS message text;

-- Deleting a category keeps its leads, uncategorized
ALTER TABLE public.leads
  ADD COLUMN category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;
CREATE INDEX leads_category_idx ON public.leads (category_id);

-- Everything imported before categories existed was medical complexes; dental clinics come next
INSERT INTO public.categories (user_id, name)
SELECT DISTINCT user_id, 'مجمعات طبية' FROM public.leads;
INSERT INTO public.categories (user_id, name)
SELECT DISTINCT user_id, 'عيادات أسنان' FROM public.leads;
UPDATE public.leads ld
SET category_id = c.id
FROM public.categories c
WHERE c.user_id = ld.user_id AND c.name = 'مجمعات طبية' AND ld.category_id IS NULL;

CREATE OR REPLACE FUNCTION public.distribute_leads(p_today date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  utc_today date := (now() AT TIME ZONE 'UTC')::date;
  total integer := 0;
  s record;
  used integer;
  n integer;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Local dates fall within a day of UTC; anything else is a broken client clock
  IF p_today IS NULL OR p_today NOT BETWEEN utc_today - 1 AND utc_today + 1 THEN
    RAISE EXCEPTION 'invalid date: %', p_today;
  END IF;

  -- One distribution at a time per user, so two calls can't grab the same lead
  PERFORM pg_advisory_xact_lock(hashtext('distribute_leads'), hashtext(uid::text));

  -- A lead manually reset to 'new' gives up its unsent assignment
  DELETE FROM public.assignments a
  USING public.leads ld
  WHERE ld.id = a.lead_id
    AND a.user_id = uid AND NOT a.sent
    AND ld.status = 'new';

  -- A lead set to 'assigned' by hand without an assignment goes back to the pool
  UPDATE public.leads ld
  SET status = 'new'
  WHERE ld.user_id = uid AND ld.status = 'assigned'
    AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id);

  -- Pending leads go back to the pool when their sender was deleted or deactivated,
  -- or their category was stopped
  WITH released AS (
    DELETE FROM public.assignments a
    USING public.leads ld
    WHERE ld.id = a.lead_id
      AND a.user_id = uid AND NOT a.sent
      AND ld.status = 'assigned' AND NOT ld.no_whatsapp
      AND (
        NOT EXISTS (SELECT 1 FROM public.senders sn WHERE sn.id = a.sender_id AND sn.active)
        OR EXISTS (SELECT 1 FROM public.categories c WHERE c.id = ld.category_id AND NOT c.active)
      )
    RETURNING a.lead_id
  )
  UPDATE public.leads SET status = 'new' WHERE id IN (SELECT lead_id FROM released);

  -- Pending leads from earlier days roll over to today
  UPDATE public.assignments a
  SET assign_date = p_today
  FROM public.leads ld
  WHERE ld.id = a.lead_id
    AND a.user_id = uid AND NOT a.sent AND a.assign_date < p_today
    AND ld.status = 'assigned' AND NOT ld.no_whatsapp;

  -- A sender over its limit (limit lowered, or a lead got its WhatsApp back)
  -- hands its newest pending leads back to the pool
  WITH ranked AS (
    SELECT a.id, sn.daily_limit,
           (NOT a.sent AND ld.status = 'assigned') AS pending,
           row_number() OVER (
             PARTITION BY a.sender_id
             ORDER BY (NOT a.sent AND ld.status = 'assigned'), a.created_at, a.id
           ) AS rn
    FROM public.assignments a
    JOIN public.senders sn ON sn.id = a.sender_id
    JOIN public.leads ld ON ld.id = a.lead_id
    WHERE a.user_id = uid AND a.assign_date = p_today
      AND (a.sent OR NOT ld.no_whatsapp)
  ), released AS (
    DELETE FROM public.assignments a
    USING ranked r
    WHERE a.id = r.id AND r.pending AND r.rn > r.daily_limit
    RETURNING a.lead_id
  )
  UPDATE public.leads SET status = 'new' WHERE id IN (SELECT lead_id FROM released);

  -- Fill each active sender up to its limit, oldest leads of active categories first
  FOR s IN
    SELECT * FROM public.senders
    WHERE user_id = uid AND active
    ORDER BY created_at, id
  LOOP
    SELECT count(*) INTO used
    FROM public.assignments a
    JOIN public.leads ld ON ld.id = a.lead_id
    WHERE a.sender_id = s.id AND a.assign_date = p_today
      AND (a.sent OR NOT ld.no_whatsapp);

    CONTINUE WHEN used >= s.daily_limit;

    WITH picked AS (
      SELECT ld.id
      FROM public.leads ld
      WHERE ld.user_id = uid
        AND ld.status = 'new'
        AND NOT ld.no_whatsapp
        AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id)
        AND NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = ld.category_id AND NOT c.active)
      ORDER BY ld.created_at, ld.id
      LIMIT s.daily_limit - used
    ), inserted AS (
      INSERT INTO public.assignments (user_id, lead_id, sender_id, assign_date)
      SELECT uid, picked.id, s.id, p_today FROM picked
      RETURNING lead_id
    )
    UPDATE public.leads SET status = 'assigned' WHERE id IN (SELECT lead_id FROM inserted);

    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    -- Fewer than requested means no new leads are left
    EXIT WHEN n < s.daily_limit - used;
  END LOOP;

  RETURN total;
END;
$$;

-- Same as 0004, but the queue only holds leads of active categories
CREATE OR REPLACE FUNCTION public.forecast_leads(p_today date, p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH s AS (
    SELECT id, daily_limit,
           sum(daily_limit) OVER (ORDER BY created_at, id) - daily_limit AS start_off
    FROM public.senders
    WHERE user_id = auth.uid() AND active
  ),
  cap AS (
    SELECT nullif(sum(daily_limit), 0) AS c FROM s
  ),
  q AS (
    SELECT ld.id, ld.phone, ld.name, ld.instagram, ld.category_id,
           row_number() OVER (ORDER BY ld.created_at, ld.id) - 1 AS rn
    FROM public.leads ld
    WHERE ld.user_id = auth.uid()
      AND ld.status = 'new'
      AND NOT ld.no_whatsapp
      AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id)
      AND NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = ld.category_id AND NOT c.active)
  )
  SELECT jsonb_build_object(
    'queued', (SELECT count(*) FROM q),
    'capacity', coalesce(cap.c, 0),
    'rows', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'sender_id', s.id, 'lead_id', q.id, 'phone', q.phone, 'name', q.name,
                 'instagram', q.instagram, 'category_id', q.category_id
               ) ORDER BY q.rn)
      FROM q
      JOIN s ON q.rn % cap.c >= s.start_off AND q.rn % cap.c < s.start_off + s.daily_limit
      WHERE q.rn / cap.c = (p_date - p_today) - 1
    ), '[]'::jsonb)
  )
  FROM cap
$$;

-- Per-category counts (category_id null = uncategorized), computed in the database so
-- they stay right no matter how many leads there are
CREATE OR REPLACE FUNCTION public.category_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'category_id', category_id, 'total', total, 'waiting', waiting,
    'pending', pending, 'sent', sent, 'no_whatsapp', no_whatsapp
  )), '[]'::jsonb)
  FROM (
    SELECT ld.category_id,
           count(*) AS total,
           -- not distributed yet (the queue)
           count(*) FILTER (WHERE ld.status = 'new' AND NOT ld.no_whatsapp AND a.id IS NULL) AS waiting,
           -- distributed, not sent yet
           count(*) FILTER (WHERE a.id IS NOT NULL AND NOT a.sent AND ld.status = 'assigned'
                              AND NOT ld.no_whatsapp) AS pending,
           count(*) FILTER (WHERE a.sent) AS sent,
           count(*) FILTER (WHERE ld.no_whatsapp) AS no_whatsapp
    FROM public.leads ld
    LEFT JOIN public.assignments a ON a.lead_id = ld.id
    WHERE ld.user_id = auth.uid()
    GROUP BY ld.category_id
  ) t
$$;

GRANT EXECUTE ON FUNCTION public.category_stats() TO authenticated;
