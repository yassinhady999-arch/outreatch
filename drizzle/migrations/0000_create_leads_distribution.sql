-- Lead status pipeline
CREATE TYPE public.lead_status AS ENUM (
  'new','assigned','contacted','replied','interested','not_interested','follow_up','closed'
);

-- Sending numbers
CREATE TABLE public.senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  phone text NOT NULL,
  label text,
  daily_limit integer NOT NULL DEFAULT 20 CHECK (daily_limit >= 0 AND daily_limit <= 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.senders TO authenticated;
GRANT ALL ON public.senders TO service_role;
ALTER TABLE public.senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own senders select" ON public.senders FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own senders insert" ON public.senders FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own senders update" ON public.senders FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own senders delete" ON public.senders FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Client numbers (leads)
CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  phone text NOT NULL,
  name text,
  country text,
  status public.lead_status NOT NULL DEFAULT 'new',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own leads select" ON public.leads FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own leads insert" ON public.leads FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own leads update" ON public.leads FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own leads delete" ON public.leads FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- One lead is assigned to exactly one sender, ever
CREATE TABLE public.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lead_id uuid NOT NULL UNIQUE REFERENCES public.leads(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.senders(id) ON DELETE CASCADE,
  assign_date date NOT NULL DEFAULT CURRENT_DATE,
  sent boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assignments_sender_date_idx ON public.assignments (sender_id, assign_date);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignments TO authenticated;
GRANT ALL ON public.assignments TO service_role;
ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own assignments select" ON public.assignments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own assignments insert" ON public.assignments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own assignments update" ON public.assignments FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own assignments delete" ON public.assignments FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Distribute today's new leads evenly across active senders, respecting daily limits
CREATE OR REPLACE FUNCTION public.distribute_leads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.distribute_leads() TO authenticated;