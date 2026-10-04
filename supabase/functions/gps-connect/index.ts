// ============================================================================
// gps-connect
//
// Called by the app (logged-in user's JWT) when a vognmand connects his GPS
// account, replaces his API keys, or re-reads his cars.
//
//   POST { action: 'connect', provider, company_name, cvr?, key, secret,
//          connection_id? }        // connection_id = replace keys of that one
//   POST { action: 'resync', connection_id }
//
// The key + secret are checked against the provider, stored in Supabase Vault
// and never returned. The response only carries counts and ids.
// Errors come back as { error: '<code>' } so the app can show Danish text.
// ============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { adminClient, json } from '../_shared/webtrack.ts';
import {
  PROVIDERS,
  GpsAuthError,
  adapterFor,
  connectionCars,
  plateFromName,
  saveToken,
  type GpsCar,
} from '../_shared/gps.ts';

type Conn = { id: string; owner_id: string; provider: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const db = adminClient();

  // Who is calling? (verify_jwt is on, so the token is already verified.)
  const auth = req.headers.get('Authorization') ?? '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const { data: userData, error: userErr } = await db.auth.getUser(jwt);
  const userId = userData?.user?.id;
  if (userErr || !userId) return json({ error: 'not_authenticated' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    if (body.action === 'connect') return await connect(db, userId, body);
    if (body.action === 'resync') return await resync(db, userId, body);
    return json({ error: 'bad_request' }, 400);
  } catch (err) {
    console.error('gps-connect error:', err instanceof Error ? err.message : String(err));
    return json({ error: 'server_error' }, 500);
  }
});

// ---------------------------------------------------------------------------

async function connect(db: SupabaseClient, userId: string, b: Record<string, unknown>) {
  const provider = String(b.provider ?? '');
  const company = String(b.company_name ?? '').trim();
  const cvr = String(b.cvr ?? '').replace(/\s+/g, '');
  const key = String(b.key ?? '').trim();
  const secret = String(b.secret ?? '').trim();
  const existingId = b.connection_id ? String(b.connection_id) : null;

  if (!PROVIDERS.includes(provider as never)) return json({ error: 'unknown_provider' }, 400);
  if (company.length < 2 || company.length > 100) return json({ error: 'invalid_company' }, 400);
  if (cvr && !/^\d{8}$/.test(cvr)) return json({ error: 'invalid_cvr' }, 400);
  if (!key || !secret || key.length > 500 || secret.length > 500) {
    return json({ error: 'missing_credentials' }, 400);
  }

  let existing: Conn | null = null;
  if (existingId) {
    const { data } = await db
      .from('gps_connections')
      .select('id, owner_id, provider')
      .eq('id', existingId)
      .eq('owner_id', userId)
      .maybeSingle();
    if (!data) return json({ error: 'not_your_connection' }, 404);
    existing = data as Conn;
  }

  // 1. Check the keys with the provider and fetch the cars.
  const adapter = adapterFor(provider);
  let token;
  let cars: GpsCar[];
  try {
    token = await adapter.authenticate({ key, secret });
    cars = await adapter.listCars(token.token);
  } catch (err) {
    if (err instanceof GpsAuthError) return json({ error: 'bad_credentials' }, 400);
    console.error('provider error:', err instanceof Error ? err.message : String(err));
    return json({ error: 'provider_unavailable' }, 502);
  }
  if (cars.length === 0) return json({ error: 'no_cars' }, 400);

  // Same account connected again by the same vognmand → replace the keys of
  // the connection he already has instead of creating a second one.
  if (!existing) {
    const { data: same } = await db
      .from('webtrack_devices')
      .select('connection_id, gps_connections!inner(id, owner_id, provider)')
      .in('device_id', cars.map((c) => c.device_id))
      .eq('gps_connections.owner_id', userId)
      .limit(1);
    const hit = (same?.[0] as { gps_connections?: Conn } | undefined)?.gps_connections;
    if (hit) existing = hit;
  }

  // 2. Cars already connected by another vognmand?
  const taken = await takenDeviceIds(db, cars, existing?.id ?? null);
  if (taken.size === cars.length) return json({ error: 'cars_taken' }, 409);

  // 3. Save the connection + secret.
  const now = new Date().toISOString();
  const fields = {
    provider,
    company_name: company,
    cvr: cvr || null,
    key_hint: key.slice(-4),
    status: 'ok',
    last_error: null,
    last_ok_at: now,
    error_notified_at: null,
    updated_at: now,
  };
  let conn: Conn;
  if (existing) {
    const { error } = await db.from('gps_connections').update(fields).eq('id', existing.id);
    if (error) throw new Error(`connection update: ${error.message}`);
    conn = { ...existing, provider };
  } else {
    const { data, error } = await db
      .from('gps_connections')
      .insert({ owner_id: userId, ...fields })
      .select('id, owner_id, provider')
      .single();
    if (error || !data) throw new Error(`connection insert: ${error?.message}`);
    conn = data as Conn;
  }

  const { error: secErr } = await db.rpc('_gps_store_secret', {
    p_connection_id: conn.id,
    p_secret: JSON.stringify({ key, secret }),
  });
  if (secErr) {
    if (!existing) await db.from('gps_connections').delete().eq('id', conn.id);
    throw new Error(`secret store: ${secErr.message}`);
  }
  await saveToken(db, conn.id, token);

  // 4. Cars.
  const result = await syncCars(db, conn, cars);
  return json({ connection_id: conn.id, ...result });
}

async function resync(db: SupabaseClient, userId: string, b: Record<string, unknown>) {
  const { data } = await db
    .from('gps_connections')
    .select('id, owner_id, provider')
    .eq('id', String(b.connection_id ?? ''))
    .eq('owner_id', userId)
    .maybeSingle();
  if (!data) return json({ error: 'not_your_connection' }, 404);
  const conn = data as Conn;

  let cars: GpsCar[];
  try {
    cars = await connectionCars(db, conn);
  } catch (err) {
    if (err instanceof GpsAuthError) {
      await db
        .from('gps_connections')
        .update({ status: 'error', last_error: 'bad_credentials', updated_at: new Date().toISOString() })
        .eq('id', conn.id);
      return json({ error: 'bad_credentials' }, 400);
    }
    console.error('provider error:', err instanceof Error ? err.message : String(err));
    return json({ error: 'provider_unavailable' }, 502);
  }

  await db
    .from('gps_connections')
    .update({ status: 'ok', last_error: null, error_notified_at: null, last_ok_at: new Date().toISOString() })
    .eq('id', conn.id);

  const result = await syncCars(db, conn, cars);
  return json({ connection_id: conn.id, ...result });
}

// ---------------------------------------------------------------------------

async function takenDeviceIds(
  db: SupabaseClient,
  cars: GpsCar[],
  ownConnectionId: string | null,
): Promise<Set<number>> {
  const ids = cars.map((c) => c.device_id);
  const { data, error } = await db
    .from('webtrack_devices')
    .select('device_id, connection_id')
    .in('device_id', ids)
    .not('connection_id', 'is', null);
  if (error) throw new Error(`device lookup: ${error.message}`);
  return new Set(
    (data ?? [])
      .filter((d) => d.connection_id !== ownConnectionId)
      .map((d) => Number(d.device_id)),
  );
}

// Upserts the cars under this connection. Cars from the old shared setup
// (connection_id NULL) are taken over; cars owned by another connection are
// skipped. Plates the vognmand already set are never overwritten.
async function syncCars(db: SupabaseClient, conn: Conn, cars: GpsCar[]) {
  const taken = await takenDeviceIds(db, cars, conn.id);
  const mine = cars.filter((c) => !taken.has(c.device_id));
  const now = new Date().toISOString();

  if (mine.length > 0) {
    const { error } = await db.from('webtrack_devices').upsert(
      mine.map((c) => ({
        device_id: c.device_id,
        connection_id: conn.id,
        provider: conn.provider,
        provider_device_id: c.provider_device_id,
        imei: c.imei,
        vin_number: c.vin_number,
        name: c.name,
        name_extra: c.name_extra,
        customer_id: c.customer_id,
        customer_name: c.customer_name,
        active: true,
        last_synced_at: now,
      })),
      { onConflict: 'device_id' },
    );
    if (error) throw new Error(`device upsert: ${error.message}`);

    // Fill a plate from the provider's name where none is set yet.
    const { data: unnamed } = await db
      .from('webtrack_devices')
      .select('device_id, name')
      .eq('connection_id', conn.id)
      .is('car_number', null);
    for (const d of unnamed ?? []) {
      const plate = plateFromName(d.name);
      if (plate) await db.from('webtrack_devices').update({ car_number: plate }).eq('device_id', d.device_id);
    }

    // The vognmand can drive his own cars.
    const { error: accErr } = await db.from('webtrack_device_access').upsert(
      mine.map((c) => ({ device_id: c.device_id, user_id: conn.owner_id, granted_by: conn.owner_id })),
      { onConflict: 'device_id,user_id', ignoreDuplicates: true },
    );
    if (accErr) throw new Error(`owner access: ${accErr.message}`);
  }

  // Cars that are gone from the account.
  let deact = db.from('webtrack_devices').update({ active: false }).eq('connection_id', conn.id);
  if (mine.length > 0) deact = deact.not('device_id', 'in', `(${mine.map((c) => c.device_id).join(',')})`);
  const { error: deErr } = await deact;
  if (deErr) throw new Error(`deactivate: ${deErr.message}`);

  return { cars: mine.length, skipped: taken.size };
}
