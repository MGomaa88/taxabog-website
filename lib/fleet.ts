// Kørselstid for vognmænd: GPS connection, cars, driver codes.
//
// The vognmand's API key + secret go to the gps-connect Edge Function once
// and are stored encrypted server side. Nothing here ever reads them back —
// the app only sees the last 4 characters (key_hint).

import { supabase } from './supabase';

export type GpsProvider = 'ecomobility';

export const PROVIDER_LABEL: Record<GpsProvider, string> = {
  ecomobility: 'EcoMobility (WebTrack)',
};

export type GpsConnection = {
  id: string;
  provider: GpsProvider;
  company_name: string;
  cvr: string | null;
  key_hint: string | null;
  status: 'ok' | 'error';
  last_error: string | null;
  last_ok_at: string | null;
  created_at: string;
};

export type FleetDriver = {
  user_id: string;
  name: string;
  is_me: boolean;
  since: string;
};

export type FleetCar = {
  device_id: number;
  connection_id: string;
  car_number: string | null;
  name: string | null;
  name_extra: string | null;
  active: boolean;
  in_use_by: string | null;
  drivers: FleetDriver[];
};

export type Fleet = { connections: GpsConnection[]; cars: FleetCar[] };

export type FleetVagt = {
  id: string;
  status: string;
  car_number: string;
  started_at: string;
  ended_at: string | null;
  driver_name: string;
  is_mine: boolean;
};

export type CarInvite = { code: string; expires_at: string; cars: string[] };

// Server error codes → Danish.
const MESSAGES: Record<string, string> = {
  bad_credentials:
    'GPS-udbyderen afviste nøglen. Tjek at key og secret er skrevet rigtigt (uden mellemrum), og at nøglen er aktiv.',
  provider_unavailable: 'GPS-udbyderen svarer ikke lige nu. Prøv igen om lidt.',
  no_cars: 'Nøglen virker, men der er ingen biler på kontoen. Kontakt din GPS-udbyder.',
  cars_taken:
    'Bilerne på denne konto er allerede forbundet af en anden bruger i TaxaBog. Kontakt support@taxabog.dk.',
  invalid_company: 'Skriv firmanavnet (2–100 tegn).',
  invalid_cvr: 'CVR-nummeret skal være 8 cifre.',
  missing_credentials: 'Udfyld både key og secret.',
  unknown_provider: 'Den GPS-udbyder understøttes ikke endnu.',
  not_your_connection: 'Forbindelsen findes ikke længere.',
  not_your_car: 'Bilen hører ikke til din GPS-forbindelse.',
  invalid_car_number: 'Nummerpladen skal være 2–12 tegn.',
  no_cars_selected: 'Vælg mindst én bil.',
  cannot_revoke_self: 'Du kan ikke fjerne din egen adgang.',
  invalid_code: 'Koden findes ikke. Tjek at du har skrevet den rigtigt.',
  own_code: 'Det er din egen kode — giv den til føreren.',
  code_used: 'Koden er allerede brugt. Bed din vognmand om en ny.',
  code_expired: 'Koden er udløbet. Bed din vognmand om en ny.',
  not_authenticated: 'Du er ikke logget ind.',
  server_error: 'Noget gik galt. Prøv igen, eller skriv til support@taxabog.dk.',
};

export function fleetErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const code of Object.keys(MESSAGES)) {
    if (raw.includes(code)) return MESSAGES[code];
  }
  return raw;
}

function fail(message: string): never {
  throw new Error(message);
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(error.message);
  return data as T;
}

export const listFleet = () => rpc<Fleet>('list_fleet');
export const listFleetVagter = (limit = 100) => rpc<FleetVagt[]>('list_fleet_vagter', { p_limit: limit });
export const setCarNumber = (deviceId: number, carNumber: string) =>
  rpc<void>('set_car_number', { p_device_id: deviceId, p_car_number: carNumber });
export const createCarInvite = (deviceIds: number[]) =>
  rpc<CarInvite>('create_car_invite', { p_device_ids: deviceIds });
export const revokeCarAccess = (deviceId: number, userId: string) =>
  rpc<void>('revoke_car_access', { p_device_id: deviceId, p_user_id: userId });
export const disconnectGps = (connectionId: string) =>
  rpc<void>('disconnect_gps', { p_connection_id: connectionId });
export const redeemCarInvite = (code: string) =>
  rpc<{ owner_name: string; cars: string[] }>('redeem_car_invite', { p_code: code.trim().toUpperCase() });

// Edge Function errors arrive as a FunctionsHttpError whose body holds
// { error: '<code>' }.
async function invokeGps(body: Record<string, unknown>): Promise<{ connection_id: string; cars: number; skipped: number }> {
  const { data, error } = await supabase.functions.invoke('gps-connect', { body });
  if (error) {
    let code = '';
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') code = (await ctx.json())?.error ?? '';
    } catch {
      // fall through
    }
    fail(code || error.message);
  }
  if (data?.error) fail(String(data.error));
  return data;
}

export function connectGps(input: {
  provider: GpsProvider;
  companyName: string;
  cvr: string;
  key: string;
  secret: string;
  connectionId?: string;
}) {
  return invokeGps({
    action: 'connect',
    provider: input.provider,
    company_name: input.companyName.trim(),
    cvr: input.cvr.replace(/\s+/g, ''),
    key: input.key.trim(),
    secret: input.secret.trim(),
    ...(input.connectionId ? { connection_id: input.connectionId } : {}),
  });
}

export function resyncGps(connectionId: string) {
  return invokeGps({ action: 'resync', connection_id: connectionId });
}

export function carLabel(c: Pick<FleetCar, 'car_number' | 'name' | 'device_id'>): string {
  return c.car_number ?? c.name ?? `Bil ${c.device_id}`;
}
