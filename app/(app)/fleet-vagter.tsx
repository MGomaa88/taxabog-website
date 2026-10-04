// Vognmand: vagter driven in his cars (all drivers). Tap → Kørselstid report
// (read-only when it is another driver's vagt).

import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../../lib/theme';
import { durationText, hhmm, shortDate } from '../../lib/vagt';
import { fleetErrorText, listFleetVagter, type FleetVagt } from '../../lib/fleet';

const OPEN = ['active', 'paused', 'pending_end'];

export default function FleetVagter() {
  const router = useRouter();
  const [vagter, setVagter] = useState<FleetVagt[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setVagter(await listFleetVagter(200));
    } catch (err) {
      Alert.alert('Fejl', fleetErrorText(err));
      setVagter((v) => v ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (vagter === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.list}
      data={vagter}
      keyExtractor={(v) => v.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={theme.colors.accent}
        />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Ingen vagter endnu</Text>
          <Text style={styles.emptySub}>Når dine førere kører vagter i dine biler, kommer de her.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const start = new Date(item.started_at);
        const end = item.ended_at ? new Date(item.ended_at) : null;
        const open = OPEN.includes(item.status);
        return (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.8}
            onPress={() =>
              router.push({ pathname: '/(app)/telemetry-detail', params: { session_id: item.id } } as never)
            }
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.date}>{shortDate(start)}</Text>
              <Text style={styles.driver}>{item.is_mine ? 'Dig' : item.driver_name}</Text>
              <Text style={styles.car}>Bil {item.car_number}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.time}>
                {hhmm(start)} – {end ? hhmm(end) : '…'}
              </Text>
              {open ? (
                <Text style={styles.live}>● I gang</Text>
              ) : (
                end && <Text style={styles.duration}>{durationText(end.getTime() - start.getTime())}</Text>
              )}
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.bg },
  list: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxl },
  card: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceElevated,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  date: { color: theme.colors.text, fontSize: 17, fontWeight: theme.font.bold },
  driver: { color: theme.colors.text, fontSize: 14, marginTop: 4 },
  car: { color: theme.colors.accent, fontSize: 13, fontFamily: mono, letterSpacing: 1, marginTop: 2 },
  time: { color: theme.colors.text, fontSize: 15, fontFamily: mono },
  duration: { color: theme.colors.textMuted, fontSize: 13, marginTop: 4 },
  live: { color: theme.colors.success, fontSize: 13, fontWeight: theme.font.bold, marginTop: 4 },
  empty: { padding: theme.spacing.xl, alignItems: 'center' },
  emptyTitle: { color: theme.colors.text, fontSize: 18, fontWeight: theme.font.bold, marginBottom: theme.spacing.sm },
  emptySub: { color: theme.colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
