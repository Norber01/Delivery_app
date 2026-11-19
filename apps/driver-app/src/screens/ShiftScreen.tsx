import type { DriverDoc } from '@courier/shared-types';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button, Card, Field, Notice, s } from '../components/ui';
import { parseOdometer } from '../core/jobs';
import { api } from '../services/api';
import { requestLocationPermissions, startShiftTracking } from '../services/location';
import { useAvailableVehicles } from '../services/hooks';
import { shiftStore } from '../services/storage';

/** Choose a vehicle and start a shift (this authorises GPS sharing). */
export function ShiftScreen({ driver, onSignOut, onPay }: { driver: DriverDoc; onSignOut: () => void; onPay: () => void }) {
  const vehicles = useAvailableVehicles(driver.homeServiceAreaId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [odometer, setOdometer] = useState('');

  async function start(vehicleId: string) {
    setBusy(vehicleId);
    setError(null);
    try {
      const odo = parseOdometer(odometer);
      if ('error' in odo) throw new Error(odo.error);
      const denied = await requestLocationPermissions();
      if (denied) throw new Error(denied);
      const shift = await api.startShift(vehicleId, odo.km);
      await shiftStore.set(shift);
      await startShiftTracking();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={s.h1}>Hello, {driver.name.split(' ')[0]}</Text>
      <Text style={s.muted}>Choose your vehicle to start your shift. Your location is shared with dispatch only while you are on shift.</Text>
      <Field label="Odometer reading now (km)" keyboardType="number-pad" value={odometer} onChangeText={setOdometer} placeholder="e.g. 12345" />
      {error && <Notice tone="error">{error}</Notice>}
      {vehicles.length === 0 && <Notice tone="warn">No vehicles are available in your area. Contact your supervisor.</Notice>}
      {vehicles.map((v) => (
        <Card key={v.id}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.h2}>{v.registrationNumber}</Text>
              <Text style={s.muted}>
                {v.vehicleClass} · up to {v.capacityKg} kg
              </Text>
            </View>
          </View>
          <Button title="Start shift with this vehicle" busy={busy === v.id} disabled={busy !== null} onPress={() => void start(v.id)} />
        </Card>
      ))}
      <Button title="My pay" tone="secondary" onPress={onPay} />
      <Button title="Sign out" tone="secondary" onPress={onSignOut} />
    </ScrollView>
  );
}
