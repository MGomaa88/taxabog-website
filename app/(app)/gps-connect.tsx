// Vognmand: connect the company's GPS account so drivers can use Kørselstid.
//
//   1. Udbyder   — EcoMobility, or "Anden udbyder" (tell us)
//   2. Firma     — company name + CVR (used in the email and on the PDF)
//   3. Nøgle     — how to get an API key, with a ready-made email
//   4. Indtast   — key + secret → checked with the provider → cars found
//
// Opened with ?connection_id=…&company_name=…&cvr=… to replace the keys of an
// existing connection (jumps straight to step 4).

import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../../lib/theme';
import { connectGps, fleetErrorText, PROVIDER_LABEL, type GpsProvider } from '../../lib/fleet';

type Step = 'provider' | 'company' | 'guide' | 'keys' | 'done';

const SUPPORT = 'support@taxabog.dk';
const ECOMOBILITY_EMAIL = 'salesdk@ecomobility.com';

export default function GpsConnect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ connection_id?: string; company_name?: string; cvr?: string }>();
  const replacing = !!params.connection_id;

  const [step, setStep] = useState<Step>(replacing ? 'keys' : 'provider');
  const [provider, setProvider] = useState<GpsProvider>('ecomobility');
  const [company, setCompany] = useState(params.company_name ?? '');
  const [cvr, setCvr] = useState(params.cvr ?? '');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [carsFound, setCarsFound] = useState(0);
  const [skipped, setSkipped] = useState(0);

  function mail(to: string, subject: string, body: string) {
    const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    Linking.openURL(url).catch(() =>
      Alert.alert('Kunne ikke åbne mail', `Skriv til ${to} med emnet "${subject}".`),
    );
  }

  function mailOtherProvider() {
    mail(
      SUPPORT,
      'Kørselstid med min GPS-udbyder',
      'Hej TaxaBog\n\nVi vil gerne bruge Kørselstid. Vores GPS-udbyder er: \n\n' +
        'Firma: \nCVR: \nAntal biler: \n\nVenlig hilsen\n',
    );
  }

  function mailEcoMobility() {
    mail(
      ECOMOBILITY_EMAIL,
      `API-adgang til WebTrack – ${company.trim()}`,
      'Hej EcoMobility\n\n' +
        `Vi er kunde hos jer (${company.trim()}${cvr.trim() ? `, CVR ${cvr.trim()}` : ''}) og vil gerne have ` +
        'en API-nøgle (key og secret) til vores WebTrack-konto.\n\n' +
        'Nøglen skal bruges i appen TaxaBog, som henter bilernes position under vores førers vagter ' +
        '(tracking/live og devices/list-ids). Der skal kun læses data.\n\n' +
        'På forhånd tak.\n\nVenlig hilsen\n',
    );
  }

  function goCompany() {
    const c = company.trim();
    const v = cvr.replace(/\s+/g, '');
    if (c.length < 2) return Alert.alert('Firmanavn mangler', 'Skriv firmaets navn.');
    if (v && !/^\d{8}$/.test(v)) return Alert.alert('CVR-nummer', 'CVR-nummeret skal være 8 cifre.');
    setStep('guide');
  }

  async function submit() {
    if (!key.trim() || !secret.trim()) {
      Alert.alert('Mangler nøgle', 'Udfyld både key og secret.');
      return;
    }
    setBusy(true);
    try {
      const res = await connectGps({
        provider,
        companyName: company,
        cvr,
        key,
        secret,
        connectionId: params.connection_id,
      });
      setKey('');
      setSecret('');
      setCarsFound(res.cars);
      setSkipped(res.skipped);
      setStep('done');
    } catch (err) {
      Alert.alert('Kunne ikke forbinde', fleetErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {!replacing && step !== 'done' && <Steps step={step} />}

        {step === 'provider' && (
          <>
            <Text style={styles.title}>Forbind jeres GPS</Text>
            <Text style={styles.body}>
              Kørselstid henter bilens position fra den GPS-tracker, der allerede sidder i bilen. Som vognmand
              forbinder du jeres GPS-konto én gang, og giver derefter dine førere adgang til bilerne med en kode.
            </Text>
            <Text style={styles.label}>Hvem leverer jeres GPS?</Text>
            <Choice
              title={PROVIDER_LABEL.ecomobility}
              subtitle="web-track.dk"
              onPress={() => {
                setProvider('ecomobility');
                setStep('company');
              }}
            />
            <Choice
              title="Anden udbyder"
              subtitle="Fortæl os hvilken — vi arbejder på flere"
              muted
              onPress={() =>
                Alert.alert(
                  'Anden GPS-udbyder',
                  'Lige nu virker Kørselstid med EcoMobility. Skriv til os, hvilken udbyder I bruger, så kontakter vi dem om en forbindelse.',
                  [
                    { text: 'Annuller', style: 'cancel' },
                    { text: 'Skriv til TaxaBog', onPress: mailOtherProvider },
                  ],
                )
              }
            />
          </>
        )}

        {step === 'company' && (
          <>
            <Text style={styles.title}>Jeres firma</Text>
            <Text style={styles.body}>
              Navnet står på Kørselstid-rapporterne for vagter i jeres biler.
            </Text>
            <Text style={styles.label}>Firmanavn</Text>
            <TextInput
              style={styles.input}
              value={company}
              onChangeText={setCompany}
              placeholder="F.eks. Hansens Taxi ApS"
              placeholderTextColor={theme.colors.textDim}
              autoCapitalize="words"
              maxLength={100}
            />
            <Text style={styles.label}>CVR-nummer (valgfrit)</Text>
            <TextInput
              style={styles.input}
              value={cvr}
              onChangeText={setCvr}
              placeholder="12345678"
              placeholderTextColor={theme.colors.textDim}
              keyboardType="number-pad"
              maxLength={10}
            />
            <Primary label="Næste" onPress={goCompany} />
            <Back onPress={() => setStep('provider')} />
          </>
        )}

        {step === 'guide' && (
          <>
            <Text style={styles.title}>Få en API-nøgle</Text>
            <Text style={styles.body}>
              TaxaBog skal have en API-nøgle fra EcoMobility for at kunne læse bilernes position. Det er kun
              vognmanden — ejeren af GPS-kontoen — der kan bestille den.
            </Text>
            <View style={styles.card}>
              <Bullet n={1} text={`Send en mail til EcoMobility (${ECOMOBILITY_EMAIL}) og bed om en API-nøgle til jeres WebTrack-konto. Tryk nedenfor — mailen er skrevet for dig.`} />
              <Bullet n={2} text="Du får en key og en secret tilbage. Det kan tage et par dage." />
              <Bullet n={3} text='Kom tilbage hertil og tryk "Jeg har nøglen".' />
            </View>
            <Primary label="Skriv mail til EcoMobility" onPress={mailEcoMobility} />
            <Secondary label="Jeg har nøglen" onPress={() => setStep('keys')} />
            <Back onPress={() => setStep('company')} />
          </>
        )}

        {step === 'keys' && (
          <>
            <Text style={styles.title}>{replacing ? 'Skift API-nøgle' : 'Indtast nøglen'}</Text>
            <Text style={styles.body}>
              {replacing
                ? `Indtast den nye nøgle til ${company || 'jeres GPS-konto'}. Bilerne og førernes adgang beholdes.`
                : 'Kopiér key og secret fra mailen fra EcoMobility og sæt dem ind her.'}
            </Text>
            {replacing && (
              <>
                <Text style={styles.label}>Firmanavn</Text>
                <TextInput
                  style={styles.input}
                  value={company}
                  onChangeText={setCompany}
                  placeholderTextColor={theme.colors.textDim}
                  maxLength={100}
                />
              </>
            )}
            <Text style={styles.label}>Key</Text>
            <TextInput
              style={[styles.input, styles.mono]}
              value={key}
              onChangeText={setKey}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              placeholder="Indsæt key"
              placeholderTextColor={theme.colors.textDim}
            />
            <Text style={styles.label}>Secret</Text>
            <TextInput
              style={[styles.input, styles.mono]}
              value={secret}
              onChangeText={setSecret}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              editable={!busy}
              placeholder="Indsæt secret"
              placeholderTextColor={theme.colors.textDim}
            />
            <View style={styles.note}>
              <Text style={styles.noteText}>
                🔒 Nøglen gemmes krypteret hos TaxaBog og vises aldrig igen i appen. Den bruges kun til at læse
                bilernes position, mens en fører har en vagt i gang. Du kan fjerne forbindelsen når som helst.
              </Text>
            </View>
            <Primary label={busy ? '' : 'Forbind'} onPress={submit} disabled={busy} loading={busy} />
            {!replacing && <Back onPress={() => setStep('guide')} />}
          </>
        )}

        {step === 'done' && (
          <>
            <Text style={styles.bigCheck}>✓</Text>
            <Text style={[styles.title, { textAlign: 'center' }]}>
              {replacing ? 'Nøglen er skiftet' : 'GPS er forbundet'}
            </Text>
            <Text style={[styles.body, { textAlign: 'center' }]}>
              {carsFound === 1 ? 'Der blev fundet 1 bil.' : `Der blev fundet ${carsFound} biler.`}
              {skipped > 0 ? ` ${skipped} bil(er) er allerede forbundet af en anden bruger og blev sprunget over.` : ''}
              {replacing ? '' : '\n\nNæste skridt: giv bilerne en nummerplade og inviter dine førere.'}
            </Text>
            <Primary label="Gå til Mine biler" onPress={() => router.replace('/(app)/fleet' as never)} />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// -------------------------------------------------------------------------

const STEP_ORDER: Step[] = ['provider', 'company', 'guide', 'keys'];

function Steps({ step }: { step: Step }) {
  const idx = STEP_ORDER.indexOf(step);
  return (
    <View style={styles.steps}>
      {STEP_ORDER.map((s, i) => (
        <View key={s} style={[styles.stepDot, i <= idx && styles.stepDotOn]} />
      ))}
    </View>
  );
}

function Choice({ title, subtitle, onPress, muted }: { title: string; subtitle: string; onPress: () => void; muted?: boolean }) {
  return (
    <TouchableOpacity style={[styles.choice, muted && { opacity: 0.85 }]} onPress={onPress} activeOpacity={0.8}>
      <View style={{ flex: 1 }}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceSub}>{subtitle}</Text>
      </View>
      <Text style={styles.chev}>›</Text>
    </TouchableOpacity>
  );
}

function Bullet({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletN}>{n}</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function Primary({ label, onPress, disabled, loading }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.primary, disabled && { opacity: 0.6 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      {loading ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

function Secondary({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.secondary} onPress={onPress} activeOpacity={0.8}>
      <Text style={styles.secondaryText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Back({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.back} onPress={onPress}>
      <Text style={styles.backText}>‹ Tilbage</Text>
    </TouchableOpacity>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  scroll: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxl },
  steps: { flexDirection: 'row', gap: 6, marginBottom: theme.spacing.xs },
  stepDot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.border },
  stepDotOn: { backgroundColor: theme.colors.accent },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: theme.font.bold },
  body: { color: theme.colors.textMuted, fontSize: 15, lineHeight: 22 },
  label: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: theme.font.bold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: theme.spacing.sm,
  },
  input: {
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontSize: 16,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  mono: { fontFamily: mono, fontSize: 14 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
  },
  choiceTitle: { color: theme.colors.text, fontSize: 17, fontWeight: theme.font.bold },
  choiceSub: { color: theme.colors.textMuted, fontSize: 13, marginTop: 2 },
  chev: { color: theme.colors.accent, fontSize: 26, fontWeight: theme.font.bold, marginLeft: theme.spacing.sm },
  card: {
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  bullet: { flexDirection: 'row', gap: theme.spacing.md },
  bulletN: {
    color: theme.colors.accentText,
    backgroundColor: theme.colors.accent,
    width: 24,
    height: 24,
    borderRadius: 12,
    textAlign: 'center',
    lineHeight: 24,
    fontWeight: theme.font.bold,
    overflow: 'hidden',
  },
  bulletText: { flex: 1, color: theme.colors.text, fontSize: 15, lineHeight: 22 },
  note: { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.md, padding: theme.spacing.md },
  noteText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  primary: {
    backgroundColor: theme.colors.accent,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
    minHeight: 52,
    justifyContent: 'center',
  },
  primaryText: { color: theme.colors.accentText, fontSize: 16, fontWeight: theme.font.bold },
  secondary: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  secondaryText: { color: theme.colors.text, fontSize: 16, fontWeight: theme.font.bold },
  back: { alignItems: 'center', padding: theme.spacing.sm },
  backText: { color: theme.colors.textDim, fontSize: 14 },
  bigCheck: { color: theme.colors.success, fontSize: 64, textAlign: 'center', marginTop: theme.spacing.xl },
});
