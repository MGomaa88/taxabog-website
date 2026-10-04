-- ============================================================================
-- Kørselstid for every vognmand.
--
-- A vognmand connects his own GPS account (EcoMobility/WebTrack first; the
-- provider column is ready for more). His API key + secret are stored in
-- Supabase Vault, never in a table the app can read and never sent back to
-- the phone. His cars land in webtrack_devices with connection_id set.
-- He names them (number plate), invites drivers with a 6-character code that
-- covers the cars he picks, can revoke access, and can read the Kørselstid
-- reports of vagter driven in his cars.
--
-- Legacy: devices with connection_id NULL still use the WEBTRACK_KEY/SECRET
-- Edge Function secrets until the owner connects the account in the app.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. GPS connections (one per vognmand GPS account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gps_connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('ecomobility')),
  company_name TEXT NOT NULL,
  cvr          TEXT,
  key_hint     TEXT,                       -- last 4 characters of the key, for display
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error   TEXT,
  last_ok_at   TIMESTAMPTZ,
  error_notified_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gps_connections_owner ON public.gps_connections (owner_id);
ALTER TABLE public.gps_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gps_connections_select_own ON public.gps_connections;
CREATE POLICY gps_connections_select_own ON public.gps_connections
  FOR SELECT USING (owner_id = auth.uid());
-- Inserts/updates only through the gps-connect Edge Function (service role).

-- Secrets + token cache. No policies at all: only the service role can read.
CREATE TABLE IF NOT EXISTS public.gps_connection_secrets (
  connection_id    UUID PRIMARY KEY REFERENCES public.gps_connections(id) ON DELETE CASCADE,
  vault_secret_id  UUID NOT NULL,
  access_token     TEXT,
  token_expires_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.gps_connection_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gps_connection_secrets FROM anon, authenticated;

-- Vault helpers (service role only).
CREATE OR REPLACE FUNCTION public._gps_store_secret(p_connection_id UUID, p_secret TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_old UUID;
  v_new UUID;
BEGIN
  SELECT vault_secret_id INTO v_old FROM public.gps_connection_secrets WHERE connection_id = p_connection_id;
  v_new := vault.create_secret(p_secret, 'gps_conn_' || p_connection_id || '_' || gen_random_uuid());
  INSERT INTO public.gps_connection_secrets (connection_id, vault_secret_id, access_token, token_expires_at)
  VALUES (p_connection_id, v_new, NULL, NULL)
  ON CONFLICT (connection_id) DO UPDATE
    SET vault_secret_id = EXCLUDED.vault_secret_id, access_token = NULL, token_expires_at = NULL, updated_at = now();
  IF v_old IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._gps_read_secret(p_connection_id UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT d.decrypted_secret
  FROM public.gps_connection_secrets s
  JOIN vault.decrypted_secrets d ON d.id = s.vault_secret_id
  WHERE s.connection_id = p_connection_id;
$$;

-- When a connection goes, its Vault secret goes too.
CREATE OR REPLACE FUNCTION public._gps_secret_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.vault_secret_id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_gps_secret_cleanup ON public.gps_connection_secrets;
CREATE TRIGGER trg_gps_secret_cleanup
  AFTER DELETE ON public.gps_connection_secrets
  FOR EACH ROW EXECUTE FUNCTION public._gps_secret_cleanup();

REVOKE ALL ON FUNCTION public._gps_store_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gps_read_secret(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._gps_secret_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._gps_store_secret(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public._gps_read_secret(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Cars belong to a connection
-- ---------------------------------------------------------------------------
ALTER TABLE public.webtrack_devices
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.gps_connections(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'ecomobility',
  ADD COLUMN IF NOT EXISTS provider_device_id TEXT;
UPDATE public.webtrack_devices SET provider_device_id = device_id::text WHERE provider_device_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_webtrack_devices_connection ON public.webtrack_devices (connection_id);

ALTER TABLE public.webtrack_device_access
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. Invitation codes for drivers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.car_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  device_ids INTEGER[] NOT NULL CHECK (cardinality(device_ids) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);
ALTER TABLE public.car_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS car_invites_select_own ON public.car_invites;
CREATE POLICY car_invites_select_own ON public.car_invites
  FOR SELECT USING (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
-- The vognmand who owns a car (via its connection), or NULL for legacy cars.
CREATE OR REPLACE FUNCTION public._device_owner(p_device_id INTEGER)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.owner_id
  FROM public.webtrack_devices d
  JOIN public.gps_connections c ON c.id = d.connection_id
  WHERE d.device_id = p_device_id;
$$;
REVOKE ALL ON FUNCTION public._device_owner(INTEGER) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._profile_name(p_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULLIF(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
  FROM public.profiles WHERE id = p_id;
$$;
REVOKE ALL ON FUNCTION public._profile_name(UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPCs for the vognmand
-- ---------------------------------------------------------------------------

-- Everything the "Mine biler" screen needs.
CREATE OR REPLACE FUNCTION public.list_fleet()
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'connections', COALESCE((
      SELECT json_agg(json_build_object(
        'id', c.id, 'provider', c.provider, 'company_name', c.company_name, 'cvr', c.cvr,
        'key_hint', c.key_hint, 'status', c.status, 'last_error', c.last_error,
        'last_ok_at', c.last_ok_at, 'created_at', c.created_at
      ) ORDER BY c.created_at)
      FROM public.gps_connections c WHERE c.owner_id = auth.uid()
    ), '[]'::json),
    'cars', COALESCE((
      SELECT json_agg(json_build_object(
        'device_id', d.device_id,
        'connection_id', d.connection_id,
        'car_number', d.car_number,
        'name', d.name,
        'name_extra', d.name_extra,
        'active', d.active,
        'in_use_by', (
          SELECT public._profile_name(v.driver_id) FROM public.vagt_sessions v
          WHERE v.webtrack_device_id = d.device_id AND v.status IN ('active', 'paused', 'pending_end')
          LIMIT 1),
        'drivers', COALESCE((
          SELECT json_agg(json_build_object(
            'user_id', a.user_id,
            'name', COALESCE(public._profile_name(a.user_id), 'Ukendt'),
            'is_me', a.user_id = auth.uid(),
            'since', a.created_at
          ) ORDER BY a.created_at)
          FROM public.webtrack_device_access a WHERE a.device_id = d.device_id
        ), '[]'::json)
      ) ORDER BY d.active DESC, COALESCE(d.car_number, d.name, d.device_id::text))
      FROM public.webtrack_devices d
      JOIN public.gps_connections c ON c.id = d.connection_id
      WHERE c.owner_id = auth.uid()
    ), '[]'::json)
  );
$$;

CREATE OR REPLACE FUNCTION public.set_car_number(p_device_id INTEGER, p_car_number TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plate TEXT := upper(regexp_replace(coalesce(p_car_number, ''), '\s+', '', 'g'));
BEGIN
  IF public._device_owner(p_device_id) IS DISTINCT FROM auth.uid() OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_your_car';
  END IF;
  IF length(v_plate) < 2 OR length(v_plate) > 12 THEN
    RAISE EXCEPTION 'invalid_car_number';
  END IF;
  UPDATE public.webtrack_devices SET car_number = v_plate WHERE device_id = p_device_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_car_invite(p_device_ids INTEGER[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids  INTEGER[];
  v_code TEXT;
  v_exp  TIMESTAMPTZ := now() + INTERVAL '7 days';
  v_try  INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_device_ids) AS x;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'no_cars_selected'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS x
    WHERE public._device_owner(x) IS DISTINCT FROM auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_your_car';
  END IF;

  LOOP
    v_code := public.gen_invite_code();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.car_invites WHERE code = v_code);
    v_try := v_try + 1;
    IF v_try > 20 THEN RAISE EXCEPTION 'could_not_generate_code'; END IF;
  END LOOP;

  INSERT INTO public.car_invites (owner_id, code, device_ids, expires_at)
  VALUES (auth.uid(), v_code, v_ids, v_exp);

  RETURN json_build_object(
    'code', v_code,
    'expires_at', v_exp,
    'cars', (SELECT json_agg(COALESCE(d.car_number, d.name, d.device_id::text) ORDER BY 1)
             FROM public.webtrack_devices d WHERE d.device_id = ANY (v_ids))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_car_access(p_device_id INTEGER, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public._device_owner(p_device_id) IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not_your_car';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'cannot_revoke_self';
  END IF;
  DELETE FROM public.webtrack_device_access WHERE device_id = p_device_id AND user_id = p_user_id;
END;
$$;

-- Disconnect a GPS account: stops polling open vagter in its cars, then
-- deletes the connection (cars, access and the Vault secret follow).
CREATE OR REPLACE FUNCTION public.disconnect_gps(p_connection_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.gps_connections
                 WHERE id = p_connection_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'not_your_connection';
  END IF;
  UPDATE public.vagt_sessions v
  SET polling_enabled = false, updated_at = now()
  FROM public.webtrack_devices d
  WHERE d.device_id = v.webtrack_device_id AND d.connection_id = p_connection_id
    AND v.status IN ('active', 'paused', 'pending_end');
  DELETE FROM public.gps_connections WHERE id = p_connection_id;
END;
$$;

-- Vagter driven in the vognmand's cars (all drivers), newest first.
CREATE OR REPLACE FUNCTION public.list_fleet_vagter(p_limit INTEGER DEFAULT 100)
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
    SELECT v.id, v.status, v.car_number, v.started_at, v.ended_at,
           COALESCE(public._profile_name(v.driver_id), 'Ukendt') AS driver_name,
           v.driver_id = auth.uid() AS is_mine
    FROM public.vagt_sessions v
    JOIN public.webtrack_devices d ON d.device_id = v.webtrack_device_id
    JOIN public.gps_connections c ON c.id = d.connection_id
    WHERE c.owner_id = auth.uid()
      AND v.status IN ('ended', 'active', 'paused', 'pending_end')
    ORDER BY v.started_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ) t;
$$;

-- ---------------------------------------------------------------------------
-- 6. RPC for the driver: redeem a code from the vognmand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_car_invite(p_code TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv public.car_invites;
  v_cars JSON;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO inv FROM public.car_invites
  WHERE code = upper(trim(p_code))
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_code'; END IF;
  IF inv.owner_id = auth.uid() THEN RAISE EXCEPTION 'own_code'; END IF;
  IF inv.used_at IS NOT NULL THEN RAISE EXCEPTION 'code_used'; END IF;
  IF inv.expires_at < now() THEN RAISE EXCEPTION 'code_expired'; END IF;

  -- Only cars the vognmand still owns.
  INSERT INTO public.webtrack_device_access (device_id, user_id, granted_by)
  SELECT d.device_id, auth.uid(), inv.owner_id
  FROM public.webtrack_devices d
  WHERE d.device_id = ANY (inv.device_ids)
    AND public._device_owner(d.device_id) = inv.owner_id
  ON CONFLICT (device_id, user_id) DO NOTHING;

  UPDATE public.car_invites SET used_by = auth.uid(), used_at = now() WHERE id = inv.id;

  SELECT json_agg(COALESCE(d.car_number, d.name, d.device_id::text) ORDER BY 1) INTO v_cars
  FROM public.webtrack_devices d
  WHERE d.device_id = ANY (inv.device_ids)
    AND public._device_owner(d.device_id) = inv.owner_id;

  RETURN json_build_object(
    'owner_name', COALESCE(public._profile_name(inv.owner_id), 'din vognmand'),
    'cars', COALESCE(v_cars, '[]'::json)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Vagt summary: the driver OR the vognmand who owns the car may read it.
--    Adds driver_name, is_mine and the company for the PDF header.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_vagt_summary(p_session_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.vagt_sessions;
  v_start TIMESTAMP;
  v_end   TIMESTAMP;
  v_span  INTEGER;
  v_stopped INTEGER;
  v_disput  INTEGER;
  v_reg_pause INTEGER;
  v_stop_pause INTEGER;
  v_pause INTEGER;
  v_review INTEGER;
  v_company TEXT;
BEGIN
  SELECT * INTO s FROM public.vagt_sessions WHERE id = p_session_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT (
       s.driver_id = auth.uid()
       OR (s.webtrack_device_id IS NOT NULL AND public._device_owner(s.webtrack_device_id) = auth.uid())
     ) THEN
    RAISE EXCEPTION 'vagt_not_found';
  END IF;

  SELECT c.company_name || COALESCE(' · CVR ' || NULLIF(c.cvr, ''), '') INTO v_company
  FROM public.webtrack_devices d JOIN public.gps_connections c ON c.id = d.connection_id
  WHERE d.device_id = s.webtrack_device_id;

  v_start := date_trunc('second', s.started_at AT TIME ZONE 'Europe/Copenhagen');
  v_end   := date_trunc('second', COALESCE(s.ended_at, now()) AT TIME ZONE 'Europe/Copenhagen');
  v_span  := GREATEST(EXTRACT(EPOCH FROM (v_end - v_start))::int, 0);

  SELECT COALESCE(SUM(duration_seconds), 0),
         COALESCE(SUM(disputable_seconds), 0),
         COUNT(*) FILTER (WHERE needs_review)
    INTO v_stopped, v_disput, v_review
  FROM public.telemetry_stops
  WHERE owner_id = s.driver_id AND car_number = s.car_number
    AND start_ts >= v_start AND start_ts < v_end;

  SELECT COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (
           LEAST(COALESCE(p.ended_at, s.ended_at, now()), COALESCE(s.ended_at, now()))
           - GREATEST(p.started_at, s.started_at)))::int, 0)), 0)
    INTO v_reg_pause
  FROM public.vagt_pauses p
  WHERE p.session_id = s.id;

  SELECT COALESCE(SUM(t.duration_seconds), 0) INTO v_stop_pause
  FROM public.telemetry_stops t
  WHERE t.owner_id = s.driver_id AND t.car_number = s.car_number
    AND t.start_ts >= v_start AND t.start_ts < v_end
    AND (t.driver_override = 'pause'
         OR (t.driver_override IS NULL AND t.classification = 'pause'))
    AND NOT EXISTS (
      SELECT 1 FROM public.vagt_pauses p
      WHERE p.session_id = s.id
        AND t.start_ts < COALESCE(p.ended_at, s.ended_at, now()) AT TIME ZONE 'Europe/Copenhagen'
        AND t.end_ts   > p.started_at AT TIME ZONE 'Europe/Copenhagen'
    );

  v_pause := LEAST(v_reg_pause + v_stop_pause, v_span);

  RETURN json_build_object(
    'session_id', s.id,
    'status', s.status,
    'car_number', s.car_number,
    'driver_name', COALESCE(public._profile_name(s.driver_id), 'Fører'),
    'is_mine', s.driver_id = auth.uid(),
    'company', v_company,
    'day', v_start::date,
    'first_ts', v_start,
    'last_ts', v_end,
    'span_seconds', v_span,
    'total_stopped_seconds', v_stopped,
    'total_driving_seconds', GREATEST(v_span - v_stopped, 0),
    'total_disputable_seconds', v_disput,
    'pause_seconds', v_pause,
    'work_seconds', GREATEST(v_span - v_pause, 0),
    'review_count', v_review,
    'shift_client_uuid', CASE WHEN s.driver_id = auth.uid() THEN s.shift_client_uuid END,
    'pauses', COALESCE((
      SELECT json_agg(json_build_object(
        'started_at', date_trunc('second', p.started_at AT TIME ZONE 'Europe/Copenhagen'),
        'ended_at',   date_trunc('second', p.ended_at AT TIME ZONE 'Europe/Copenhagen'),
        'source',     p.source
      ) ORDER BY p.started_at)
      FROM public.vagt_pauses p WHERE p.session_id = s.id
    ), '[]'::json),
    'stops', COALESCE((
      SELECT json_agg(json_build_object(
        'id', t.id,
        'start_ts', t.start_ts,
        'end_ts', t.end_ts,
        'duration_seconds', t.duration_seconds,
        'address', t.address,
        'lat', t.lat,
        'lng', t.lng,
        'statuses_seen', t.statuses_seen,
        'classification', t.classification,
        'disputable_seconds', t.disputable_seconds,
        'driver_override', t.driver_override,
        'needs_review', t.needs_review
      ) ORDER BY t.start_ts)
      FROM public.telemetry_stops t
      WHERE t.owner_id = s.driver_id AND t.car_number = s.car_number
        AND t.start_ts >= v_start AND t.start_ts < v_end
    ), '[]'::json)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.list_fleet(),
  public.set_car_number(INTEGER, TEXT),
  public.create_car_invite(INTEGER[]),
  public.revoke_car_access(INTEGER, UUID),
  public.disconnect_gps(UUID),
  public.list_fleet_vagter(INTEGER),
  public.redeem_car_invite(TEXT),
  public.get_vagt_summary(UUID)
TO authenticated;
