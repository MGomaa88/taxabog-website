// Vognmand: "Mine biler".
//   - GPS connection(s): status, re-read cars, change key, disconnect
//   - each car: number plate (tap to change), who drives it, remove a driver
//   - "Inviter fører": pick cars → 6-character code to give the driver
//   - "Vagter i mine biler" → Kørselstid reports for vagter in his cars

import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../../lib/theme';
import {
  carLabel,
  createCarInvite,
  disconnectGps,
  fleetErrorText,
  listFleet,
  PROVIDER_LABEL,
  resyncGps,
  revokeCarAccess,
  setCarNumber,
  type CarInvite,
  type Fleet,
  type FleetCar,
  type FleetDriver,
  type GpsConnection,
} from '../../lib/fleet';

export default function FleetScreen() {
  const router = useRouter();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [plateCar, setPlateCar] = useState<FleetCar | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setFleet(await listFleet());
    } catch (err) {
      Alert.alert('Fejl', fleetErrorText(err));
      setFleet((f) => f ?? { connections: [], cars: [] });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function resync(c: GpsConnection) {
    setBusy(c.id);
    try {
      const res = await resyncGps(c.id);
      Alert.alert('Biler opdateret', res.cars === 1 ? '1 bil på kontoen.' : `${res.cars} biler på kontoen.`);
    } catch (err) {
      Alert.alert('Kunne ikke hente biler', fleetErrorText(err));
    } finally {
      setBusy(null);
      load();
    }
  }

  function changeKey(c: GpsConnection) {
    router.push({
      pathname: '/(app)/gps-connect',
      params: { connection_id: c.id, company_name: c.company_name, cvr: c.cvr ?? '' },
    } as never);
  }

  function confirmDisconnect(c: GpsConnection) {
    Alert.alert(
      'Fjern GPS-forbindelsen?',
      `${c.company_name}: API-nøglen slettes, bilerne fjernes fra TaxaBog, og førerne mister adgang. ` +
        'Igangværende vagter i bilerne får ikke flere GPS-positioner.\n\nAfsluttede vagter beholdes hos førerne.',
      [
        { text: 'Annuller', style: 'cancel' },
        {
          text: 'Fjern',
          style: 'destructive',
          onPress: async () => {
            setBusy(c.id);
            try {
              await disconnectGps(c.id);
            } catch (err) {
              Alert.alert('Kunne ikke fjerne', fleetErrorText(err));
            } finally {
              setBusy(null);
              load();
            }
          },
        },
      ],
    );
  }

  function confirmRevoke(car: FleetCar, d: FleetDriver) {
    Alert.alert(
      `Fjern ${d.name}?`,
      `${d.name} kan ikke længere starte vagter i bil ${carLabel(car)}.` +
        (car.in_use_by === d.name ? '\n\nFøreren har en vagt i gang i bilen — den fortsætter, til føreren slutter den.' : ''),
      [
        { text: 'Annuller', style: 'cancel' },
        {
          text: 'Fjern adgang',
          style: 'destructive',
          onPress: async () => {
            try {
              await revokeCarAccess(car.device_id, d.user_id);
            } catch (err) {
              Alert.alert('Kunne ikke fjerne', fleetErrorText(err));
            } finally {
              load();
            }
          },
        },
      ],
    );
  }

  if (!fleet) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const activeCars = fleet.cars.filter((c) => c.active);
  const goneCars = fleet.cars.filter((c) => !c.active);

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
      >
        {fleet.connections.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Ingen GPS forbundet</Text>
            <Text style={styles.body}>Forbind jeres GPS-konto for at bruge Kørselstid i jeres biler.</Text>
            <Button label="Forbind GPS" kind="primary" onPress={() => router.push('/(app)/gps-connect' as never)} />
          </View>
        )}

        {fleet.connections.map((c) => (
          <View key={c.id} style={[styles.card, c.status === 'error' && styles.cardError]}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{c.company_name}</Text>
                <Text style={styles.meta}>
                  {PROVIDER_LABEL[c.provider] ?? c.provider}
                  {c.cvr ? ` · CVR ${c.cvr}` : ''}
                  {c.key_hint ? ` · nøgle ••••${c.key_hint}` : ''}
                </Text>
              </View>
              {busy === c.id ? (
                <ActivityIndicator color={theme.colors.accent} />
              ) : (
                <Text style={[styles.status, c.status === 'error' ? styles.statusError : styles.statusOk]}>
                  {c.status === 'error' ? 'Virker ikke' : 'Forbundet'}
                </Text>
              )}
            </View>
            {c.status === 'error' && (
              <Text style={styles.errorText}>
                GPS-udbyderen afviser nøglen, så der registreres ikke kørsel. Bed udbyderen om en ny nøgle og tryk
                "Skift nøgle".
              </Text>
            )}
            <View style={styles.buttonRow}>
              <Button label="Hent biler igen" onPress={() => resync(c)} disabled={busy !== null} />
              <Button label="Skift nøgle" onPress={() => changeKey(c)} disabled={busy !== null} />
            </View>
            <TouchableOpacity onPress={() => confirmDisconnect(c)} disabled={busy !== null}>
              <Text style={styles.dangerLink}>Fjern forbindelsen</Text>
            </TouchableOpacity>
          </View>
        ))}

        {fleet.connections.length > 0 && (
          <>
            <View style={styles.buttonRow}>
              <Button
                label="Inviter fører"
                kind="primary"
                onPress={() => setInviteOpen(true)}
                disabled={activeCars.length === 0}
              />
              <Button label="Vagter i mine biler" onPress={() => router.push('/(app)/fleet-vagter' as never)} />
            </View>

            <Text style={styles.section}>Biler ({activeCars.length})</Text>
            {activeCars.length === 0 && (
              <Text style={styles.body}>Ingen aktive biler på kontoen. Tryk "Hent biler igen".</Text>
            )}
            {activeCars.map((car) => (
              <CarCard
                key={car.device_id}
                car={car}
                onPlate={() => setPlateCar(car)}
                onRevoke={(d) => confirmRevoke(car, d)}
              />
            ))}

            {goneCars.length > 0 && (
              <>
                <Text style={styles.section}>Ikke længere på GPS-kontoen</Text>
                {goneCars.map((car) => (
                  <Text key={car.device_id} style={styles.meta}>
                    {carLabel(car)}
                  </Text>
                ))}
              </>
            )}

            <TouchableOpacity onPress={() => router.push('/(app)/gps-connect' as never)} style={{ padding: theme.spacing.sm }}>
              <Text style={styles.link}>+ Forbind endnu en GPS-konto</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      <PlateSheet
        car={plateCar}
        onClose={() => setPlateCar(null)}
        onSaved={() => {
          setPlateCar(null);
          load();
        }}
      />
      <InviteSheet visible={inviteOpen} cars={activeCars} onClose={() => setInviteOpen(false)} />
    </>
  );
}

// -------------------------------------------------------------------------

function CarCard({
  car,
  onPlate,
  onRevoke,
}: {
  car: FleetCar;
  onPlate: () => void;
  onRevoke: (d: FleetDriver) => void;
}) {
  const others = car.drivers.filter((d) => !d.is_me);
  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.row} onPress={onPlate} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          {car.car_number ? (
            <Text style={styles.plate}>{car.car_number}</Text>
          ) : (
            <Text style={styles.plateMissing}>Tilføj nummerplade</Text>
          )}
          {car.name && car.name !== car.car_number && <Text style={styles.meta}>GPS-navn: {car.name}</Text>}
        </View>
        <Text style={styles.link}>Ret ›</Text>
      </TouchableOpacity>
      {car.in_use_by && <Text style={styles.inUse}>● Vagt i gang: {car.in_use_by}</Text>}
      {others.length === 0 ? (
        <Text style={styles.meta}>Ingen førere endnu</Text>
      ) : (
        <View style={styles.chips}>
          {others.map((d) => (
            <TouchableOpacity key={d.user_id} style={styles.chip} onPress={() => onRevoke(d)} activeOpacity={0.7}>
              <Text style={styles.chipText}>{d.name}</Text>
              <Text style={styles.chipX}>✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

function PlateSheet({ car, onClose, onSaved }: { car: FleetCar | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);

  if (car && car.device_id !== lastId) {
    setLastId(car.device_id);
    setValue(car.car_number ?? '');
  }

  async function save() {
    if (!car) return;
    setSaving(true);
    try {
      await setCarNumber(car.device_id, value);
      onSaved();
    } catch (err) {
      Alert.alert('Kunne ikke gemme', fleetErrorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={!!car} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Nummerplade</Text>
            {car?.name && <Text style={styles.meta}>GPS-navn: {car.name}</Text>}
            <TextInput
              style={styles.plateInput}
              value={value}
              onChangeText={setValue}
              placeholder="AB12345"
              placeholderTextColor={theme.colors.textDim}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={14}
              autoFocus
            />
            <Text style={styles.meta}>Vises for førerne og på Kørselstid-rapporterne.</Text>
            <Button label={saving ? 'Gemmer…' : 'Gem'} kind="primary" onPress={save} disabled={saving} />
            <TouchableOpacity style={{ alignItems: 'center', padding: theme.spacing.sm }} onPress={onClose}>
              <Text style={styles.cancel}>Annuller</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function InviteSheet({ visible, cars, onClose }: { visible: boolean; cars: FleetCar[]; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [invite, setInvite] = useState<CarInvite | null>(null);
  const [creating, setCreating] = useState(false);

  function close() {
    setSelected(new Set());
    setInvite(null);
    onClose();
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    if (selected.size === 0) {
      Alert.alert('Vælg biler', 'Vælg de biler, føreren må køre i.');
      return;
    }
    setCreating(true);
    try {
      setInvite(await createCarInvite([...selected]));
    } catch (err) {
      Alert.alert('Kunne ikke lave kode', fleetErrorText(err));
    } finally {
      setCreating(false);
    }
  }

  function share() {
    if (!invite) return;
    Share.share({
      message:
        `Din kode til Kørselstid i TaxaBog: ${invite.code}\n\n` +
        `Åbn TaxaBog → Kørselstid → "Indtast bilkode". Koden giver adgang til: ${invite.cars.join(', ')}. ` +
        `Den virker én gang og udløber ${expiryText(invite.expires_at)}.`,
    }).catch(() => {});
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {!invite ? (
            <>
              <Text style={styles.sheetTitle}>Inviter fører</Text>
              <Text style={styles.body}>Vælg de biler, føreren må starte vagter i.</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {cars.map((car) => {
                  const on = selected.has(car.device_id);
                  return (
                    <TouchableOpacity
                      key={car.device_id}
                      style={[styles.pickRow, on && styles.pickRowOn]}
                      onPress={() => toggle(car.device_id)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.pickBox}>{on ? '☑' : '☐'}</Text>
                      <Text style={styles.pickLabel}>{carLabel(car)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {cars.length > 1 && (
                <TouchableOpacity
                  onPress={() =>
                    setSelected(selected.size === cars.length ? new Set() : new Set(cars.map((c) => c.device_id)))
                  }
                >
                  <Text style={styles.link}>{selected.size === cars.length ? 'Fravælg alle' : 'Vælg alle'}</Text>
                </TouchableOpacity>
              )}
              <View style={styles.note}>
                <Text style={styles.noteText}>
                  Føreren får at vide, at du kan se Kørselstid-rapporterne for vagter i dine biler.
                </Text>
              </View>
              <Button label={creating ? 'Laver kode…' : 'Lav kode'} kind="primary" onPress={create} disabled={creating} />
            </>
          ) : (
            <>
              <Text style={styles.sheetTitle}>Giv koden til føreren</Text>
              <Text style={styles.code}>{invite.code}</Text>
              <Text style={[styles.body, { textAlign: 'center' }]}>
                Gælder: {invite.cars.join(', ')}
                {'\n'}Virker én gang · udløber {expiryText(invite.expires_at)}
              </Text>
              <Button label="Del koden" kind="primary" onPress={share} />
            </>
          )}
          <TouchableOpacity style={{ alignItems: 'center', padding: theme.spacing.sm }} onPress={close}>
            <Text style={styles.cancel}>{invite ? 'Færdig' : 'Annuller'}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function expiryText(iso: string): string {
  const d = new Date(iso);
  const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  return `${d.getDate()}. ${months[d.getMonth()]}`;
}

function Button({
  label,
  onPress,
  kind = 'secondary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, kind === 'primary' ? styles.buttonPrimary : styles.buttonSecondary, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <Text style={[styles.buttonText, { color: kind === 'primary' ? theme.colors.accentText : theme.colors.text }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.bg },
  scroll: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxl },
  card: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  cardError: { borderColor: theme.colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  cardTitle: { color: theme.colors.text, fontSize: 18, fontWeight: theme.font.bold },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  body: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  meta: { color: theme.colors.textMuted, fontSize: 13 },
  status: { fontSize: 12, fontWeight: theme.font.bold, letterSpacing: 0.5 },
  statusOk: { color: theme.colors.success },
  statusError: { color: theme.colors.error },
  errorText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  buttonRow: { flexDirection: 'row', gap: theme.spacing.sm },
  button: {
    flexGrow: 1,
    flexBasis: 0,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
  buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  buttonSecondary: { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
  buttonText: { fontSize: 15, fontWeight: theme.font.bold, textAlign: 'center' },
  dangerLink: { color: theme.colors.error, fontSize: 13, textAlign: 'center', paddingTop: theme.spacing.xs },
  link: { color: theme.colors.accent, fontSize: 14, fontWeight: theme.font.bold },
  section: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: theme.font.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: theme.spacing.sm,
  },
  plate: { color: theme.colors.text, fontSize: 20, fontWeight: theme.font.bold, fontFamily: mono, letterSpacing: 1 },
  plateMissing: { color: theme.colors.accent, fontSize: 16, fontWeight: theme.font.bold },
  inUse: { color: theme.colors.success, fontSize: 13, fontWeight: theme.font.medium },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipText: { color: theme.colors.text, fontSize: 13 },
  chipX: { color: theme.colors.textDim, fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  sheetTitle: { color: theme.colors.text, fontSize: 20, fontWeight: theme.font.bold },
  plateInput: {
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: theme.font.bold,
    fontFamily: mono,
    letterSpacing: 2,
    textAlign: 'center',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cancel: { color: theme.colors.textDim, fontSize: 14 },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
    marginBottom: theme.spacing.sm,
  },
  pickRowOn: { borderColor: theme.colors.accent },
  pickBox: { color: theme.colors.accent, fontSize: 20 },
  pickLabel: { color: theme.colors.text, fontSize: 17, fontWeight: theme.font.bold, fontFamily: mono },
  note: { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.md, padding: theme.spacing.md },
  noteText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  code: {
    color: theme.colors.accent,
    fontSize: 40,
    fontWeight: theme.font.bold,
    fontFamily: mono,
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  },
});
