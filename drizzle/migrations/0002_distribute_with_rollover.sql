CREATE OR REPLACE FUNCTION public.distribute_leads()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  total integer := 0;
  s record;
  l record;
  cap integer;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Roll over unsent assignments from previous days to today
  UPDATE public.assignments
  SET assign_date = CURRENT_DATE
  WHERE user_id = uid AND sent = false AND assign_date < CURRENT_DATE;

  FOR s IN
    SELECT * FROM public.senders
    WHERE user_id = uid AND active
    ORDER BY created_at
  LOOP
    cap := s.daily_limit - (
      SELECT count(*) FROM public.assignments a
      WHERE a.sender_id = s.id AND a.assign_date = CURRENT_DATE
    );

    WHILE cap > 0 LOOP
      SELECT ld.* INTO l
      FROM public.leads ld
      WHERE ld.user_id = uid
        AND ld.status = 'new'
        AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.lead_id = ld.id)
      ORDER BY ld.created_at
      LIMIT 1;

      IF NOT FOUND THEN
        RETURN total;
      END IF;

      INSERT INTO public.assignments (user_id, lead_id, sender_id, assign_date)
      VALUES (uid, l.id, s.id, CURRENT_DATE);

      UPDATE public.leads SET status = 'assigned' WHERE id = l.id;

      cap := cap - 1;
      total := total + 1;
    END LOOP;
  END LOOP;

  RETURN total;
END;
$function$;