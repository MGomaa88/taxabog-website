#!/usr/bin/env python3
"""v39: Kørselstid for vognmænd — wires the new screens into the app.

- Kørselstid screen: "Mine biler" / "Kom i gang" / "Indtast bilkode" under the live card
- Car picker with no cars: buttons to enter a car code or connect GPS
- Vagt report: read-only for the vognmand (another driver's vagt), shows the driver
- PDF: driver name + the vognmand's company instead of a fixed company line
- Screen titles

Idempotent. Checks every file first and writes nothing if a pattern is missing.
"""
import sys, pathlib

if not pathlib.Path('app/(app)/_layout.tsx').exists():
    sys.exit('ABORT: run from ~/taxa-app')

EDITS = {}  # path -> list of (old, new, label)

def edit(path, old, new, label):
    EDITS.setdefault(path, []).append((old, new, label))

# ---------------------------------------------------------------- koerselstid
K = 'app/(app)/koerselstid.tsx'
edit(K, "import { LiveVagtCard } from '../../components/LiveVagtCard';\n",
        "import { LiveVagtCard } from '../../components/LiveVagtCard';\nimport { FleetEntry } from '../../components/FleetEntry';\n",
        'import FleetEntry')
edit(K, "          <LiveVagtCard />\n          {vagter.length > 0",
        "          <LiveVagtCard />\n          <FleetEntry />\n          {vagter.length > 0",
        'render FleetEntry')

# ---------------------------------------------------------------- LiveVagtCard
L = 'components/LiveVagtCard.tsx'
edit(L, """            ) : cars.length === 0 ? (
              <Text style={styles.body}>
                Du har ikke adgang til nogen GPS-biler endnu. Kørselstid er til flextrafik og kræver en GPS-tracker fra web-track.dk i bilen, og at din vognmand har givet dig adgang. Kontakt din vognmand eller support@taxabog.dk.
              </Text>
            ) : (""", """            ) : cars.length === 0 ? (
              <>
                <Text style={styles.body}>
                  Du har ikke adgang til nogen biler endnu. Kørselstid er til flextrafik og bruger GPS-trackeren i
                  bilen. Har din vognmand givet dig en kode, så indtast den her. Er du selv vognmand, så forbind
                  jeres GPS.
                </Text>
                <View style={styles.buttonRow}>
                  <ActionButton
                    label="Indtast bilkode"
                    kind="primary"
                    onPress={() => {
                      setCarPickerOpen(false);
                      router.push('/(app)/car-code' as never);
                    }}
                  />
                  <ActionButton
                    label="Jeg er vognmand"
                    kind="secondary"
                    onPress={() => {
                      setCarPickerOpen(false);
                      router.push('/(app)/gps-connect' as never);
                    }}
                  />
                </View>
              </>
            ) : (""", 'no-cars buttons')

# ---------------------------------------------------------------- telemetry-api
A = 'lib/telemetry-api.ts'
edit(A, """  shift_client_uuid?: string | null;
  pauses?: VagtPause[];
};""", """  shift_client_uuid?: string | null;
  pauses?: VagtPause[];
  driver_name?: string;
  is_mine?: boolean; // false = the vognmand viewing a driver's vagt in his car
  company?: string | null; // "Firma ApS · CVR 12345678" of the car's GPS connection
};""", 'DaySummary fields')

# ---------------------------------------------------------------- telemetry-detail
T = 'app/(app)/telemetry-detail.tsx'
edit(T, """  async function makePdf() {
    if (!summary || !profile) return;
    setGeneratingPdf(true);
    try {
      const ownerName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Fører';""",
        """  async function makePdf() {
    if (!summary || !profile) return;
    setGeneratingPdf(true);
    try {
      const ownerName =
        summary.driver_name ||
        [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
        'Fører';""", 'pdf driver name')
edit(T, """    const pending = summary?.stops.filter((s) => s.needs_review).length ?? 0;
    if (pending === 0) {""", """    const pending = summary?.stops.filter((s) => s.needs_review).length ?? 0;
    if (pending === 0 || summary?.is_mine === false) {""", 'pdf skip review prompt for vognmand')
edit(T, """  const hasWork = typeof summary.work_seconds === 'number';
""", """  const hasWork = typeof summary.work_seconds === 'number';
  // The vognmand looking at a driver's vagt in his car: view only.
  const readOnly = isVagt && summary.is_mine === false;
""", 'readOnly flag')
edit(T, """      {reviewStops.length > 0 && (
        <View style={x.reviewBanner}>""", """      {readOnly && (
        <View style={x.viewerBanner}>
          <Text style={x.viewerTitle}>Fører: {summary.driver_name ?? 'Ukendt'}</Text>
          <Text style={x.viewerBody}>
            Du ser vagten, fordi den er kørt i din bil. Kun føreren kan bekræfte stop.
          </Text>
        </View>
      )}
      {!readOnly && reviewStops.length > 0 && (
        <View style={x.reviewBanner}>""", 'viewer banner')
edit(T, """        {isVagt && !summary.shift_client_uuid && (""",
        """        {isVagt && !readOnly && !summary.shift_client_uuid && (""", 'hide regnskab')
edit(T, """            <StopRow key={stop.id} stop={stop} index={i + 1} onToggle={(next) => handleToggleOverride(stop.id, next)} />""",
        """            <StopRow
              key={stop.id}
              stop={stop}
              index={i + 1}
              readOnly={readOnly}
              onToggle={(next) => handleToggleOverride(stop.id, next)}
            />""", 'StopRow readOnly prop')
edit(T, """function StopRow({ stop, index, onToggle }: { stop: DayStop; index: number; onToggle: (next: DriverOverride) => void }) {""",
        """function StopRow({
  stop,
  index,
  onToggle,
  readOnly,
}: {
  stop: DayStop;
  index: number;
  onToggle: (next: DriverOverride) => void;
  readOnly?: boolean;
}) {""", 'StopRow signature')
edit(T, """      {!isTraffic && (
        <View style={styles.toggleWrap}>
          <ToggleButton label="Arbejde\"""", """      {!isTraffic && readOnly && (
        <Text style={styles.toggleHint}>
          {state === 'arbejde' ? 'Arbejde' : 'Pause'}
          {stop.needs_review ? ' · ikke bekræftet' : stop.driver_override !== null ? ' · bekræftet af føreren' : ' · auto'}
        </Text>
      )}
      {!isTraffic && !readOnly && (
        <View style={styles.toggleWrap}>
          <ToggleButton label="Arbejde\"""", 'StopRow read-only state')
edit(T, """  stopRowReview: { borderColor: theme.colors.accent },""",
        """  stopRowReview: { borderColor: theme.colors.accent },
  viewerBanner: {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    gap: 4,
  },
  viewerTitle: { color: theme.colors.text, fontSize: 16, fontWeight: theme.font.bold },
  viewerBody: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19 },""", 'viewer styles')

# ---------------------------------------------------------------- telemetry-pdf
P = 'lib/telemetry-pdf.ts'
edit(P, """    <div class="meta-row">
      <span class="meta-label">Ejer</span>
      <span class="meta-value">${escapeHtml(ownerName)}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Virksomhed</span>
      <span class="meta-value">EgyDan ApS · CVR 46090942</span>
    </div>""", """    <div class="meta-row">
      <span class="meta-label">Fører</span>
      <span class="meta-value">${escapeHtml(ownerName)}</span>
    </div>
    ${s.company ? `<div class="meta-row">
      <span class="meta-label">Vognmand</span>
      <span class="meta-value">${escapeHtml(s.company)}</span>
    </div>` : ''}""", 'pdf company from GPS connection')

# ---------------------------------------------------------------- layout
Y = 'app/(app)/_layout.tsx'
edit(Y, """        <Stack.Screen name="telemetry-detail" options={{ title: 'Vagt' }} />
""", """        <Stack.Screen name="telemetry-detail" options={{ title: 'Vagt' }} />
        <Stack.Screen name="gps-connect" options={{ title: 'Forbind GPS' }} />
        <Stack.Screen name="fleet" options={{ title: 'Mine biler' }} />
        <Stack.Screen name="fleet-vagter" options={{ title: 'Vagter i mine biler' }} />
        <Stack.Screen name="car-code" options={{ title: 'Bilkode' }} />
""", 'screen titles')

# ---------------------------------------------------------------- apply
for f in ['components/FleetEntry.tsx', 'lib/fleet.ts', 'app/(app)/gps-connect.tsx', 'app/(app)/fleet.tsx',
          'app/(app)/fleet-vagter.tsx', 'app/(app)/car-code.tsx']:
    if not pathlib.Path(f).exists():
        sys.exit(f'ABORT: {f} missing - extract the v39 package first')

new_text = {}
for path, edits in EDITS.items():
    p = pathlib.Path(path)
    if not p.exists():
        sys.exit(f'ABORT: {path} not found')
    s = p.read_text()
    for old, new, label in edits:
        if new in s:
            print(f'  already done: {path}: {label}')
            continue
        n = s.count(old)
        if n != 1:
            sys.exit(f'ABORT: {path}: pattern for "{label}" found {n} times - nothing written')
        s = s.replace(old, new)
        print(f'  patched: {path}: {label}')
    new_text[path] = s

for path, s in new_text.items():
    p = pathlib.Path(path)
    if p.read_text() != s:
        p.write_text(s)
print('done')
