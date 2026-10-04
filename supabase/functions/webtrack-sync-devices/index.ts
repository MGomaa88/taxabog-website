// ============================================================================
// webtrack-sync-devices
//
// Pulls GET devices/list-ids from WebTrack and upserts into
// public.webtrack_devices.
//
// - car_number is set from the WebTrack device name ONLY when it is empty,
//   so manual corrections in the table editor are never overwritten.
// - Devices no longer returned by WebTrack are marked active = false.
// - Only the OLD shared setup (WEBTRACK_KEY/SECRET, connection_id NULL).
//   Cars a vognmand has connected in the app (connection_id set) are left
//   alone here; gps-connect keeps those in sync.
// - Admin only: must be called with the service role key.
//
// Invoke:
//   curl -X POST https://<project>.supabase.co/functions/v1/webtrack-sync-devices \
//        -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
// ============================================================================

import {
  adminClient,
  isServiceRoleRequest,
  json,
  webtrackRequest,
  type WebtrackDeviceListItem,
} from '../_shared/webtrack.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!isServiceRoleRequest(req)) return json({ error: 'Forbidden' }, 403);

  try {
    const db = adminClient();
    const devices = await webtrackRequest<WebtrackDeviceListItem[]>(db, 'devices/list-ids');
    const now = new Date().toISOString();

    // Cars a vognmand has connected himself are not ours to touch.
    const { data: owned, error: ownErr } = await db
      .from('webtrack_devices')
      .select('device_id')
      .not('connection_id', 'is', null);
    if (ownErr) throw new Error(`owned lookup failed: ${ownErr.message}`);
    const ownedIds = new Set((owned ?? []).map((d) => Number(d.device_id)));

    const rows = (devices ?? [])
      .filter((d) => d?.identifier?.device_id != null)
      .filter((d) => !ownedIds.has(Number(d.identifier.device_id)))
      .map((d) => ({
        device_id: d.identifier.device_id,
        imei: d.identifier.imei != null ? String(d.identifier.imei) : null,
        vin_number: d.identifier.vin_number ?? null,
        name: d.info?.name?.trim() || null,
        name_extra: d.info?.name_extra?.trim() || null,
        customer_id: d.customer?.id ?? null,
        customer_name: d.customer?.name ?? null,
        active: true,
        last_synced_at: now,
      }));

    if (rows.length > 0) {
      const { error } = await db
        .from('webtrack_devices')
        .upsert(rows, { onConflict: 'device_id' });
      if (error) throw new Error(`upsert failed: ${error.message}`);

      // Mark devices that disappeared from WebTrack as inactive.
      const ids = rows.map((r) => r.device_id).join(',');
      const { error: deactErr } = await db
        .from('webtrack_devices')
        .update({ active: false })
        .is('connection_id', null)
        .not('device_id', 'in', `(${ids})`);
      if (deactErr) throw new Error(`deactivate failed: ${deactErr.message}`);
    }

    // Fill car_number from the device name where it hasn't been set yet.
    const { data: unmapped, error: selErr } = await db
      .from('webtrack_devices')
      .select('device_id, name')
      .is('connection_id', null)
      .is('car_number', null);
    if (selErr) throw new Error(`select failed: ${selErr.message}`);

    for (const d of unmapped ?? []) {
      if (!d.name) continue;
      const { error } = await db
        .from('webtrack_devices')
        .update({ car_number: d.name })
        .eq('device_id', d.device_id);
      if (error) throw new Error(`car_number fill failed: ${error.message}`);
    }

    const { data: result, error: listErr } = await db
      .from('webtrack_devices')
      .select('device_id, name, name_extra, car_number, customer_name, active')
      .is('connection_id', null)
      .order('device_id');
    if (listErr) throw new Error(`list failed: ${listErr.message}`);

    return json({ synced: rows.length, devices: result });
  } catch (err) {
    console.error('webtrack-sync-devices error:', String(err));
    return json({ error: String(err) }, 502);
  }
});
