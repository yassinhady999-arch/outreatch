-- Distribution fixes:
--  * deleting a sender keeps its sent history and frees its pending leads
--  * deactivating a sender or lowering its limit frees its pending leads
--  * "today" is the client's local date, not the server's UTC date
--  * no-WhatsApp leads are skipped, and only still-pending leads roll over
--  * concurrent calls for the same user run one at a time
--
-- Pending assignment = unsent, lead still 'assigned', lead has WhatsApp.
-- Every assignment counts toward its sender's daily limit except unsent no-WhatsApp ones.

-- Present in the live database but never captured in a migration
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS no_whatsapp boolean NOT NULL DEFAULT false;

-- Deleting a sender keeps its assignments (and the sent log) with sender_id = NULL
ALTER TABLE public.assignments ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE public.assignments DROP CONSTRAINT assignments_sender_id_fkey;
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES public.senders(id) ON DELETE SET NULL;

-- Leads stranded as 'assigned' by earlier sender deletions go back to the pool
UPDATE public.leads ld
SET status = 'new'
WHERE ld.status = 'assigned'
  AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id);

DROP FUNCTION IF EXISTS public.distribute_leads();

CREATE FUNCTION public.distribute_leads(p_today date DEFAULT CURRENT_DATE)
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
             ORDER BY (NOT a.sent AND ld.status = 'assigned'), a.created_at
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
    ORDER BY created_at
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
      ORDER BY ld.created_at
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

GRANT EXECUTE ON FUNCTION public.distribute_leads(date) TO authenticated;
