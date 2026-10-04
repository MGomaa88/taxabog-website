#!/usr/bin/env python3
"""v39: poll-active-shifts polls each vognmand's own GPS account.

Groups open vagter by the car's GPS connection: one tracking/live call per
connection (cars from the old shared setup keep using WEBTRACK_KEY/SECRET).
When a vognmand's keys stop working, his connection is marked 'error' and
he gets one email. Idempotent; aborts without writing if a pattern is missing.
"""
import sys, pathlib

P = pathlib.Path('supabase/functions/poll-active-shifts/index.ts')
if not P.exists():
    sys.exit(f'ABORT: {P} not found - run from ~/taxa-app')
s = P.read_text()
orig = s

def rep(old, new, label):
    global s
    if new in s:
        print(f'  already done: {label}')
        return
    if s.count(old) != 1:
        sys.exit(f'ABORT: pattern for "{label}" found {s.count(old)} times - nothing written')
    s = s.replace(old, new)
    print(f'  patched: {label}')

rep("""  type WebtrackLivePosition,
} from '../_shared/webtrack.ts';
""", """  type WebtrackLivePosition,
} from '../_shared/webtrack.ts';
import { GpsAuthError, connectionPositions } from '../_shared/gps.ts';
""", 'import gps')

rep("""  stopped_since: string | null;
  last_position_at: string | null;
};
""", """  stopped_since: string | null;
  last_position_at: string | null;
  webtrack_devices?: { connection_id: string | null } | null;
};
""", 'Session type')

rep(""".select('id, driver_id, car_number, webtrack_device_id, status, started_at, stopped_since, last_position_at')""",
    """.select('id, driver_id, car_number, webtrack_device_id, status, started_at, stopped_since, last_position_at, webtrack_devices(connection_id)')""",
    'select connection')

rep("""    const positions = await webtrackRequest<WebtrackLivePosition[]>(db, 'tracking/live');
    const byDevice = new Map<number, WebtrackLivePosition>();
    for (const p of positions ?? []) byDevice.set(Number(p.device_id), p);

    const now = new Date();
    for (const s of sessions as Session[]) {
      const p = byDevice.get(Number(s.webtrack_device_id));
      if (!p) continue;
      stats.positions++;
      try {
        await processSession(db, s, p, now, stats);
      } catch (err) {
        console.error(`session ${s.id}:`, String(err));
        errors.push(`session ${s.id}: ${String(err)}`);
      }
    }
""", """    // One tracking/live call per GPS account ('' = old shared setup).
    const groups = new Map<string, Session[]>();
    // (webtrack_devices is a many-to-one embed, so it arrives as an object.)
    for (const s of sessions as unknown as Session[]) {
      const key = s.webtrack_devices?.connection_id ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    const now = new Date();
    for (const [connectionId, group] of groups) {
      let positions: WebtrackLivePosition[];
      try {
        positions = connectionId
          ? await positionsForConnection(db, connectionId)
          : await webtrackRequest<WebtrackLivePosition[]>(db, 'tracking/live');
      } catch (err) {
        console.error(`positions ${connectionId || 'legacy'}:`, String(err));
        errors.push(`positions ${connectionId || 'legacy'}: ${String(err)}`);
        continue;
      }
      const byDevice = new Map<number, WebtrackLivePosition>();
      for (const p of positions ?? []) byDevice.set(Number(p.device_id), p);

      for (const s of group) {
        const p = byDevice.get(Number(s.webtrack_device_id));
        if (!p) continue;
        stats.positions++;
        try {
          await processSession(db, s, p, now, stats);
        } catch (err) {
          console.error(`session ${s.id}:`, String(err));
          errors.push(`session ${s.id}: ${String(err)}`);
        }
      }
    }
""", 'grouped polling')

rep("""// ---------------------------------------------------------------------------
// Per-vagt processing
// ---------------------------------------------------------------------------
""", """// ---------------------------------------------------------------------------
// A vognmand's own GPS account. Keeps gps_connections.status up to date and
// emails the vognmand once when his keys stop working.
// ---------------------------------------------------------------------------

async function positionsForConnection(
  db: SupabaseClient,
  connectionId: string,
): Promise<WebtrackLivePosition[]> {
  const { data: conn, error } = await db
    .from('gps_connections')
    .select('id, owner_id, provider, company_name, status, error_notified_at')
    .eq('id', connectionId)
    .single();
  if (error || !conn) throw new Error(`connection lookup: ${error?.message ?? 'not found'}`);

  try {
    const positions = await connectionPositions(db, conn);
    await db
      .from('gps_connections')
      .update({
        status: 'ok',
        last_error: null,
        error_notified_at: null,
        last_ok_at: new Date().toISOString(),
      })
      .eq('id', conn.id);
    return positions;
  } catch (err) {
    if (err instanceof GpsAuthError) {
      const update: Record<string, unknown> = {
        status: 'error',
        last_error: 'bad_credentials',
        updated_at: new Date().toISOString(),
      };
      if (!conn.error_notified_at) {
        const sent = await sendConnectionErrorEmail(db, conn.owner_id, conn.company_name);
        if (sent) update.error_notified_at = new Date().toISOString();
      }
      await db.from('gps_connections').update(update).eq('id', conn.id);
    }
    throw err;
  }
}

async function sendConnectionErrorEmail(
  db: SupabaseClient,
  ownerId: string,
  company: string,
): Promise<boolean> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('FROM_ADDRESS') ?? 'TaxaBog <noreply@taxabog.dk>';
  const support = Deno.env.get('SUPPORT_EMAIL') ?? 'support@taxabog.dk';
  if (!apiKey) return false;

  const { data: profile } = await db
    .from('profiles')
    .select('email, first_name')
    .eq('id', ownerId)
    .maybeSingle();
  if (!profile?.email) return false;

  const name = profile.first_name ? ' ' + escapeHtml(profile.first_name) : '';
  const html = `<!doctype html>
<html lang="da"><body style="font-family:-apple-system,system-ui,sans-serif;background:#fafafa;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:12px;border:1px solid #eaeaea;">
    <h2 style="margin:0 0 12px;color:#111;">GPS-forbindelsen virker ikke</h2>
    <p style="color:#444;line-height:1.6;">Hej${name},</p>
    <p style="color:#444;line-height:1.6;">
      TaxaBog kan ikke længere hente GPS-data for <strong>${escapeHtml(company)}</strong>.
      GPS-udbyderen afviser API-nøglen — den kan være slettet eller udløbet.
      Imens bliver der ikke registreret kørsel på vagter i dine biler.
    </p>
    <p style="color:#444;line-height:1.6;">
      Åbn TaxaBog → <strong>Kørselstid</strong> → <strong>Mine biler</strong> og tryk
      <strong>Skift API-nøgle</strong>. Har du ikke en ny nøgle, så bed din GPS-udbyder om en.
    </p>
    <p style="color:#888;font-size:12px;margin-top:24px;">
      TaxaBog · EgyDan ApS · <a href="mailto:${support}" style="color:#111;">${support}</a>
    </p>
  </div>
</body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: profile.email,
        subject: `GPS-forbindelsen for ${company} virker ikke`,
        html,
        reply_to: support,
      }),
    });
    if (!res.ok) console.error('resend failed:', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('resend error:', String(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-vagt processing
// ---------------------------------------------------------------------------
""", 'connection helpers')

rep("""//   2. ONE call to GET tracking/live — it returns every device on the
//      account, so the cost is one call per minute no matter how many
//      cars are on shift.""", """//   2. ONE call to GET tracking/live per GPS account (each vognmand's own
//      connection; the old shared setup counts as one) — it returns every
//      device on the account, so the cost is one call per minute per
//      account no matter how many cars are on shift.""", 'header comment')

if s != orig:
    P.write_text(s)
    print('poll-active-shifts updated')
else:
    print('poll-active-shifts: nothing to change')
