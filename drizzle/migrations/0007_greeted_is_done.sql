-- A greeted lead is done for the day: it no longer counts as "pending".
--
-- Once the greeting goes out (leads.greeted_at), the lead stays on the day it was greeted:
-- it doesn't roll over, isn't released or trimmed, and so doesn't take a slot from new
-- clinics on later days. Its assignment stays unsent until the clinic replies and gets its
-- own message (sent by the bot, whenever the reply comes). Without this, every greeting
-- left unanswered would roll over and eat the next day's capacity.
--
-- Pending = unsent, still 'assigned', has WhatsApp, and not greeted yet.

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

  -- Pending (not yet greeted) leads go back to the pool when their sender was deleted or
  -- deactivated, or their category was stopped
  WITH released AS (
    DELETE FROM public.assignments a
    USING public.leads ld
    WHERE ld.id = a.lead_id
      AND a.user_id = uid AND NOT a.sent
      AND ld.status = 'assigned' AND NOT ld.no_whatsapp AND ld.greeted_at IS NULL
      AND (
        NOT EXISTS (SELECT 1 FROM public.senders sn WHERE sn.id = a.sender_id AND sn.active)
        OR EXISTS (SELECT 1 FROM public.categories c WHERE c.id = ld.category_id AND NOT c.active)
      )
    RETURNING a.lead_id
  )
  UPDATE public.leads SET status = 'new' WHERE id IN (SELECT lead_id FROM released);

  -- Pending leads from earlier days roll over to today (greeted ones stay on their day)
  UPDATE public.assignments a
  SET assign_date = p_today
  FROM public.leads ld
  WHERE ld.id = a.lead_id
    AND a.user_id = uid AND NOT a.sent AND a.assign_date < p_today
    AND ld.status = 'assigned' AND NOT ld.no_whatsapp AND ld.greeted_at IS NULL;

  -- A sender over its limit (limit lowered, or a lead got its WhatsApp back)
  -- hands its newest pending leads back to the pool
  WITH ranked AS (
    SELECT a.id, sn.daily_limit,
           (NOT a.sent AND ld.status = 'assigned' AND ld.greeted_at IS NULL) AS pending,
           row_number() OVER (
             PARTITION BY a.sender_id
             ORDER BY (NOT a.sent AND ld.status = 'assigned' AND ld.greeted_at IS NULL), a.created_at, a.id
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

-- Adds "greeted" (greeted, waiting for the reply); "pending" now means not greeted yet
CREATE OR REPLACE FUNCTION public.category_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'category_id', category_id, 'total', total, 'waiting', waiting,
    'pending', pending, 'greeted', greeted, 'sent', sent, 'no_whatsapp', no_whatsapp
  )), '[]'::jsonb)
  FROM (
    SELECT ld.category_id,
           count(*) AS total,
           -- not distributed yet (the queue)
           count(*) FILTER (WHERE ld.status = 'new' AND NOT ld.no_whatsapp AND a.id IS NULL) AS waiting,
           -- distributed, not sent yet
           count(*) FILTER (WHERE a.id IS NOT NULL AND NOT a.sent AND ld.status = 'assigned'
                              AND NOT ld.no_whatsapp AND ld.greeted_at IS NULL) AS pending,
           -- greeted, waiting for the clinic's reply
           count(*) FILTER (WHERE ld.greeted_at IS NOT NULL AND a.id IS NOT NULL AND NOT a.sent)
             AS greeted,
           count(*) FILTER (WHERE a.sent) AS sent,
           count(*) FILTER (WHERE ld.no_whatsapp) AS no_whatsapp
    FROM public.leads ld
    LEFT JOIN public.assignments a ON a.lead_id = ld.id
    WHERE ld.user_id = auth.uid()
    GROUP BY ld.category_id
  ) t
$$;
