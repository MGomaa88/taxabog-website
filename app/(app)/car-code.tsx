// Driver: redeem the 6-character code from the vognmand → access to his cars.

import { useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../../lib/theme';
import { fleetErrorText, redeemCarInvite } from '../../lib/fleet';

export default function CarCode() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function redeem() {
    const c = code.trim().toUpperCase();
    if (c.length !== 6) {
      Alert.alert('Ugyldig kode', 'Koden skal være 6 tegn.');
      return;
    }
    setBusy(true);
    try {
      const res = await redeemCarInvite(c);
      const cars = res.cars.length ? res.cars.join(', ') : 'ingen biler';
      Alert.alert(
        'Adgang givet',
        `${res.owner_name} har givet dig adgang til: ${cars}.\n\nTryk "Start vagt" under Kørselstid, når du begynder at køre.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err) {
      Alert.alert('Kunne ikke bruge koden', fleetErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Indtast bilkode</Text>
        <Text style={styles.body}>
          Din vognmand laver koden i TaxaBog under Kørselstid → Mine biler. Den giver dig adgang til at starte
          vagter i de biler, vognmanden har valgt.
        </Text>

        <TextInput
          style={styles.codeInput}
          value={code}
          onChangeText={setCode}
          placeholder="ABCD23"
          placeholderTextColor={theme.colors.textDim}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
          editable={!busy}
        />

        <View style={styles.note}>
          <Text style={styles.noteTitle}>Det skal du vide</Text>
          <Text style={styles.noteText}>
            Din vognmand kan se dine Kørselstid-rapporter for de biler, du får adgang til: tidspunkter, stop,
            pauser og adresser fra bilens GPS under dine vagter. Dit regnskab (indkørt, drikkepenge osv.) kan
            vognmanden ikke se.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.button, busy && { opacity: 0.6 }]}
          onPress={redeem}
          disabled={busy}
          activeOpacity={0.8}
        >
          {busy ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.buttonText}>Brug koden</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  scroll: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxl },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: theme.font.bold },
  body: { color: theme.colors.textMuted, fontSize: 15, lineHeight: 22 },
  codeInput: {
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.accent,
    fontSize: 32,
    fontWeight: theme.font.bold,
    letterSpacing: 8,
    textAlign: 'center',
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  note: { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.md, padding: theme.spacing.md, gap: 4 },
  noteTitle: { color: theme.colors.accent, fontSize: 14, fontWeight: theme.font.bold },
  noteText: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  button: {
    backgroundColor: theme.colors.accent,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  buttonText: { color: theme.colors.accentText, fontSize: 16, fontWeight: theme.font.bold },
});
