import type { DeliveryDoc } from '@courier/shared-types';
import { StatusBar } from 'expo-status-bar';
import { onIdTokenChanged, signOut, type User } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, SafeAreaView, View } from 'react-native';
import { colors, Notice, s } from './src/components/ui';
import { JobScreen } from './src/screens/JobScreen';
import { JobsScreen } from './src/screens/JobsScreen';
import { FuelScreen } from './src/screens/FuelScreen';
import { PayScreen } from './src/screens/PayScreen';
import { ShiftScreen } from './src/screens/ShiftScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { auth } from './src/services/firebase';
import { useDriver, useJobs } from './src/services/hooks';
import { startShiftTracking, stopShiftTracking } from './src/services/location';
import { actionQueue } from './src/services/queue';
import { shiftStore } from './src/services/storage';

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onIdTokenChanged(auth, setUser), []);
  // Flush queued actions whenever the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void actionQueue.process());
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaView style={[s.screen, { paddingTop: 24 }]}>
      <StatusBar style="dark" />
      {user === undefined ? <Loading /> : user ? <Signed uid={user.uid} /> : <SignInScreen />}
    </SafeAreaView>
  );
}

function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.brand} size="large" />
    </View>
  );
}

function Signed({ uid }: { uid: string }) {
  const driver = useDriver(uid);
  const jobs = useJobs(uid);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<'jobs' | 'fuel' | 'pay'>('jobs');
  const onShift = Boolean(driver?.currentShift && new Date(driver.currentShift.activeUntil) > new Date());

  // Keep the GPS service in step with the server-side shift (e.g. after a restart or expiry).
  useEffect(() => {
    if (driver === undefined) return;
    if (onShift && driver?.currentShift) void shiftStore.set(driver.currentShift).then(startShiftTracking);
    else void stopShiftTracking().then(shiftStore.clear);
  }, [onShift, driver]);

  if (driver === undefined) return <Loading />;
  if (driver === null || driver.status !== 'active') {
    return (
      <View style={s.content}>
        <Notice tone="error">This driver account is not active. Contact your supervisor.</Notice>
      </View>
    );
  }
  if (view === 'pay') return <PayScreen uid={uid} onBack={() => setView('jobs')} />;
  if (!onShift) return <ShiftScreen driver={driver} onSignOut={() => void signOut(auth)} onPay={() => setView('pay')} />;
  if (view === 'fuel') return <FuelScreen onBack={() => setView('jobs')} />;
  const open: DeliveryDoc | undefined = jobs.find((j) => j.id === openId);
  if (open) return <JobScreen job={open} onBack={() => setOpenId(null)} />;
  return <JobsScreen driver={driver} onOpen={(d) => setOpenId(d.id)} onFuel={() => setView('fuel')} onPay={() => setView('pay')} />;
}
