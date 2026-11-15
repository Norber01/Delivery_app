import type { DeliveryDoc, DriverDoc } from '@courier/shared-types';
import { PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { nextStep, sortJobs } from '../core/jobs';
import { Button, Card, Notice, s } from '../components/ui';
import { api } from '../services/api';
import { useHistory, useJobs, useManifests, useQueue } from '../services/hooks';
import { stopShiftTracking } from '../services/location';
import { actionQueue } from '../services/queue';
import { shiftStore } from '../services/storage';

export function JobsScreen({ driver, onOpen }: { driver: DriverDoc; onOpen: (d: DeliveryDoc) => void }) {
  const jobs = sortJobs(useJobs(driver.uid));
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const history = useHistory(driver.uid, tab === 'history');
  const queue = useQueue();
  const manifests = useManifests(driver.uid);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = tab === 'current' ? jobs : history;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <View style={s.row}>
        <Text style={[s.h1, { flex: 1 }]}>My jobs</Text>
        <Text style={s.muted}>{driver.currentShift?.vehicleClass} · on shift</Text>
      </View>
      {queue.pending.length > 0 && (
        <Notice tone="warn">
          {queue.pending.length} update(s) waiting for signal — they will send automatically.
          {queue.pending[0]?.lastError ? ` (${queue.pending[0].lastError})` : ''}
        </Notice>
      )}
      {queue.failed.map((f) => (
        <Pressable key={f.request.actionId} onPress={() => void actionQueue.dismissFailed(f.request.actionId)}>
          <Notice tone="error">
            {f.request.deliveryId}: {f.message} (tap to dismiss)
          </Notice>
        </Pressable>
      ))}
      <View style={s.row}>
        <Button title={`Current (${jobs.length})`} tone={tab === 'current' ? 'primary' : 'secondary'} onPress={() => setTab('current')} />
        <Button title="History" tone={tab === 'history' ? 'primary' : 'secondary'} onPress={() => setTab('history')} />
      </View>
      {tab === 'current' &&
        manifests.map((m) => (
          <Card key={m.id}>
            <Text style={s.h2}>Linehaul {m.routeCode}</Text>
            <Text style={s.text}>
              {m.deliveryIds.length} parcel(s) · {m.totalWeightKg} kg · vehicle {m.vehicleRegistration}
            </Text>
            <Text style={s.muted}>
              {m.status === 'departed'
                ? `On the road — expected ${m.expectedArrivalAt ? new Date(m.expectedArrivalAt).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' }) : ''}. Hub staff unload and scan on arrival.`
                : m.status === 'arrived'
                  ? 'Arrived — waiting for unloading.'
                  : `Departs ${new Date(m.scheduledDepartureAt).toLocaleString('en-GH', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Hub staff load and release the vehicle.`}
            </Text>
          </Card>
        ))}
      {list.length === 0 && <Text style={s.muted}>{tab === 'current' ? 'No jobs right now. Dispatch will assign you one.' : 'No past jobs yet.'}</Text>}
      {list.map((d) => (
        <Pressable key={d.id} onPress={() => onOpen(d)} accessibilityRole="button">
          <Card>
            <View style={s.row}>
              <Text style={[s.h2, { flex: 1 }]}>{PUBLIC_STATUS_LABELS[d.status]}</Text>
              {d.urgency !== 'standard' && <Text style={{ color: '#1d4ed8', fontWeight: '700' }}>{d.urgency.replace('_', ' ').toUpperCase()}</Text>}
            </View>
            <Text style={s.text}>
              {d.status === 'out_for_delivery' || d.status === 'delivery_failed' ? d.destination.line1 : d.pickup.line1}
            </Text>
            <Text style={s.muted}>{nextStep(d)}</Text>
          </Card>
        </Pressable>
      ))}
      {error && <Notice tone="error">{error}</Notice>}
      <Button
        title="End shift"
        tone="danger"
        busy={busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.endShift();
            await stopShiftTracking();
            await shiftStore.clear();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </ScrollView>
  );
}
