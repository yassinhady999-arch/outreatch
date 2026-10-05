-- Deterministic distribution order + a forecast of future days.
--
-- A bulk import inserts every lead with the same created_at, so "ORDER BY created_at" alone
-- could pick tied leads in any order. Both functions now break ties by id, so the forecast
-- shows exactly the leads distribute_leads() will hand out on that day.

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

  -- Pending leads of deleted or deactivated senders go back to the pool
  WITH released AS (
    DELETE FROM public.assignments a
    USING public.leads ld
    WHERE ld.id = a.lead_id
      AND a.user_id = uid AND NOT a.sent
      AND ld.status = 'assigned' AND NOT ld.no_whatsapp
      AND NOT EXISTS (
        SELECT 1 FROM public.senders sn WHERE sn.id = a.sender_id AND sn.active
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

  -- Fill each active sender up to its limit, oldest leads first
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

-- Which leads each active sender gets on a future p_date, assuming every earlier day's
-- batch gets sent. Same queue, order and sender fill as distribute_leads(): day k after
-- today takes queue positions [(k-1)*C, k*C) where C is the total daily capacity, split
-- across senders in creation order. Returned as one jsonb value so the API row limit
-- doesn't cut it short.
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
    SELECT ld.id, ld.phone, ld.name, ld.instagram,
           row_number() OVER (ORDER BY ld.created_at, ld.id) - 1 AS rn
    FROM public.leads ld
    WHERE ld.user_id = auth.uid()
      AND ld.status = 'new'
      AND NOT ld.no_whatsapp
      AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id)
  )
  SELECT jsonb_build_object(
    'queued', (SELECT count(*) FROM q),
    'capacity', coalesce(cap.c, 0),
    'rows', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'sender_id', s.id, 'lead_id', q.id,
                 'phone', q.phone, 'name', q.name, 'instagram', q.instagram
               ) ORDER BY q.rn)
      FROM q
      JOIN s ON q.rn % cap.c >= s.start_off AND q.rn % cap.c < s.start_off + s.daily_limit
      WHERE q.rn / cap.c = (p_date - p_today) - 1
    ), '[]'::jsonb)
  )
  FROM cap
$$;

GRANT EXECUTE ON FUNCTION public.forecast_leads(date, date) TO authenticated;
