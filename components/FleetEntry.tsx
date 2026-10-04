// Kørselstid entry points under the live card:
//   vognmand with a GPS connection → "Mine biler" card
//   no cars at all                  → "Kom i gang": Jeg er vognmand / Jeg har en bilkode
//   driver with cars                → small "Indtast bilkode" link

import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../lib/theme';
import { listFleet, type Fleet } from '../lib/fleet';
import { listMyCars } from '../lib/vagt';

export function FleetEntry() {
  const router = useRouter();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [carCount, setCarCount] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      Promise.all([listFleet(), listMyCars()])
        .then(([f, cars]) => {
          if (!alive) return;
          setFleet(f);
          setCarCount(cars.length);
        })
        .catch((err) => console.warn('fleet entry load failed:', String(err)));
      return () => {
        alive = false;
      };
    }, []),
  );

  if (!fleet || carCount === null) return null;

  if (fleet.connections.length > 0) {
    const broken = fleet.connections.some((c) => c.status === 'error');
    const cars = fleet.cars.filter((c) => c.active);
    const drivers = new Set(cars.flatMap((c) => c.drivers.filter((d) => !d.is_me).map((d) => d.user_id))).size;
    const unnamed = cars.filter((c) => !c.car_number).length;
    return (
      <TouchableOpacity
        style={[styles.card, broken && styles.cardError]}
        onPress={() => router.push('/(app)/fleet' as never)}
        activeOpacity={0.8}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Mine biler</Text>
          <Text style={styles.sub}>
            {broken
              ? 'GPS-forbindelsen virker ikke — tryk for at skifte nøgle'
              : `${cars.length} ${cars.length === 1 ? 'bil' : 'biler'} · ${drivers} ${drivers === 1 ? 'fører' : 'førere'}` +
                (unnamed > 0 ? ` · ${unnamed} mangler nummerplade` : '')}
          </Text>
        </View>
        <Text style={styles.chev}>›</Text>
      </TouchableOpacity>
    );
  }

  if (carCount === 0) {
    return (
      <View style={styles.card}>
        <View style={{ flex: 1, gap: theme.spacing.sm }}>
          <Text style={styles.title}>Kom i gang med Kørselstid</Text>
          <Text style={styles.sub}>
            Kørselstid er til flextrafik. Den bruger GPS-trackeren, der sidder i bilen, og din vognmand giver dig
            adgang til bilerne.
          </Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.button, styles.buttonPrimary]}
              onPress={() => router.push('/(app)/car-code' as never)}
              activeOpacity={0.8}
            >
              <Text style={[styles.buttonText, { color: theme.colors.accentText }]}>Jeg har en bilkode</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.button}
              onPress={() => router.push('/(app)/gps-connect' as never)}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonText}>Jeg er vognmand</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity onPress={() => router.push('/(app)/car-code' as never)} style={styles.linkWrap}>
      <Text style={styles.link}>Har du fået en bilkode? Indtast den ›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  cardError: { borderColor: theme.colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  title: { color: theme.colors.text, fontSize: 17, fontWeight: theme.font.bold },
  sub: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  chev: { color: theme.colors.accent, fontSize: 26, fontWeight: theme.font.bold, marginLeft: theme.spacing.sm },
  row: { flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.xs },
  button: {
    flexGrow: 1,
    flexBasis: 0,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  buttonText: { fontSize: 14, fontWeight: theme.font.bold, color: theme.colors.text, textAlign: 'center' },
  linkWrap: { alignItems: 'center', paddingVertical: theme.spacing.xs },
  link: { color: theme.colors.accent, fontSize: 14, fontWeight: theme.font.bold },
});
