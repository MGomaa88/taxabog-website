// ============================================================================
// GPS providers for vognmand connections (Kørselstid for every vognmand).
//
// Each vognmand stores his own API credentials once, through the gps-connect
// Edge Function. They live in Supabase Vault (gps_connection_secrets →
// vault.secrets) and are only ever read here, server side, with the service
// role. They are never logged and never sent back to the app.
//
// One adapter per provider. Adding a provider = one more adapter object +
// the provider name in the gps_connections CHECK constraint.
//
// Legacy cars (webtrack_devices.connection_id IS NULL) still use the
// WEBTRACK_KEY / WEBTRACK_SECRET secrets via _shared/webtrack.ts.
// ============================================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { WEBTRACK_BASE_URL, type WebtrackDeviceListItem, type WebtrackLivePosition } from './webtrack.ts';

export type ProviderId = 'ecomobility';
export const PROVIDERS: ProviderId[] = ['ecomobility'];

export type GpsCredentials = { key: string; secret: string };

// A car as the provider reports it.
export type GpsCar = {
  device_id: number;
  provider_device_id: string;
  name: string | null;
  name_extra: string | null;
  imei: string | null;
  vin_number: string | null;
  customer_id: number | null;
  customer_name: string | null;
};

// A live position, in the shape the poller already understands.
export type GpsPosition = WebtrackLivePosition;

// Thrown when the provider rejects the credentials (wrong, revoked, expired).
// Anything else (network, 5xx, rate limit) is a plain Error = temporary.
export class GpsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpsAuthError';
  }
}

type Token = { token: string; expiresAt: Date };

type Adapter = {
  authenticate(creds: GpsCredentials): Promise<Token>;
  listCars(token: string): Promise<GpsCar[]>;
  livePositions(token: string): Promise<GpsPosition[]>;
};

// ---------------------------------------------------------------------------
// EcoMobility (WebTrack API v0.4.3) — 4 calls per minute per account.
// ---------------------------------------------------------------------------

async function webtrackFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${WEBTRACK_BASE_URL}/${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new GpsAuthError(`WebTrack ${path}: ${res.status}`);
  }
  if (!res.ok) throw new Error(`WebTrack ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const ecomobility: Adapter = {
  async authenticate({ key, secret }) {
    const res = await fetch(`${WEBTRACK_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, secret }),
    });
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      throw new GpsAuthError(`WebTrack auth rejected (${res.status})`);
    }
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new Error(`WebTrack auth failed (${res.status})`);
    }
    const expiresIn = Number(body.expires_in) || 7 * 24 * 3600;
    return { token: body.access_token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  },

  async listCars(token) {
    const list = await webtrackFetch<WebtrackDeviceListItem[]>(token, 'devices/list-ids');
    return (list ?? [])
      .filter((d) => d?.identifier?.device_id != null)
      .map((d) => ({
        device_id: Number(d.identifier.device_id),
        provider_device_id: String(d.identifier.device_id),
        name: d.info?.name?.trim() || null,
        name_extra: d.info?.name_extra?.trim() || null,
        imei: d.identifier.imei != null ? String(d.identifier.imei) : null,
        vin_number: d.identifier.vin_number ?? null,
        customer_id: d.customer?.id ?? null,
        customer_name: d.customer?.name ?? null,
      }));
  },

  async livePositions(token) {
    return (await webtrackFetch<WebtrackLivePosition[]>(token, 'tracking/live')) ?? [];
  },
};

const ADAPTERS: Record<ProviderId, Adapter> = { ecomobility };

export function adapterFor(provider: string): Adapter {
  const a = ADAPTERS[provider as ProviderId];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}

// ---------------------------------------------------------------------------
// Per-connection token cache (gps_connection_secrets.access_token).
// ---------------------------------------------------------------------------

const REFRESH_MARGIN_MS = 3 * 60 * 60 * 1000;

async function readCredentials(db: SupabaseClient, connectionId: string): Promise<GpsCredentials> {
  const { data, error } = await db.rpc('_gps_read_secret', { p_connection_id: connectionId });
  if (error) throw new Error(`secret read failed: ${error.message}`);
  if (!data) throw new GpsAuthError('no credentials stored');
  const parsed = JSON.parse(data as string);
  if (!parsed?.key || !parsed?.secret) throw new GpsAuthError('credentials incomplete');
  return { key: String(parsed.key), secret: String(parsed.secret) };
}

export async function saveToken(db: SupabaseClient, connectionId: string, t: Token): Promise<void> {
  const { error } = await db
    .from('gps_connection_secrets')
    .update({
      access_token: t.token,
      token_expires_at: t.expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('connection_id', connectionId);
  if (error) throw new Error(`token save failed: ${error.message}`);
}

async function connectionToken(
  db: SupabaseClient,
  conn: { id: string; provider: string },
  force = false,
): Promise<string> {
  if (!force) {
    const { data, error } = await db
      .from('gps_connection_secrets')
      .select('access_token, token_expires_at')
      .eq('connection_id', conn.id)
      .maybeSingle();
    if (error) throw new Error(`token read failed: ${error.message}`);
    if (
      data?.access_token &&
      data.token_expires_at &&
      new Date(data.token_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS
    ) {
      return data.access_token as string;
    }
  }
  const t = await adapterFor(conn.provider).authenticate(await readCredentials(db, conn.id));
  await saveToken(db, conn.id, t);
  return t.token;
}

// Runs fn with a cached token; on an auth error, refreshes once and retries.
async function withToken<T>(
  db: SupabaseClient,
  conn: { id: string; provider: string },
  fn: (token: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await connectionToken(db, conn));
  } catch (err) {
    if (!(err instanceof GpsAuthError)) throw err;
    return await fn(await connectionToken(db, conn, true));
  }
}

export function connectionCars(db: SupabaseClient, conn: { id: string; provider: string }) {
  return withToken(db, conn, (t) => adapterFor(conn.provider).listCars(t));
}

export function connectionPositions(db: SupabaseClient, conn: { id: string; provider: string }) {
  return withToken(db, conn, (t) => adapterFor(conn.provider).livePositions(t));
}

// "ab 12 345" → "AB12345"; null if it can't be a plate.
export function plateFromName(name: string | null): string | null {
  if (!name) return null;
  const p = name.toUpperCase().replace(/\s+/g, '');
  return p.length >= 2 && p.length <= 12 ? p : null;
}
