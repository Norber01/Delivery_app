import { DRIVER_EXCEPTION_REASONS, type DriverActionType, type ExceptionReason } from '@courier/constants';
import type { DeliveryDoc, SignatureStrokes } from '@courier/shared-types';
import { formatGhs, PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useState } from 'react';
import { Image, Linking, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { navigationUrl, newActionId, nextStep } from '../core/jobs';
import { LabelScanner } from '../components/LabelScanner';
import { SignaturePad } from '../components/SignaturePad';
import { Button, Card, colors, Field, Notice, s } from '../components/ui';
import { config } from '../services/config';
import { actionQueue } from '../services/queue';

type Mode = 'view' | 'scan' | 'deliver' | 'return' | 'problem';
const REASON_TEXT: Record<Exclude<ExceptionReason, 'missing_in_transit'>, string> = {
  recipient_unavailable: 'Recipient not available',
  sender_unavailable: 'Sender not available',
  wrong_address: 'Wrong or unclear address',
  refused: 'Refused',
  damaged: 'Package damaged',
  access_denied: 'Could not get access',
  weather: 'Weather',
  vehicle_breakdown: 'Vehicle breakdown',
  package_not_ready: 'Package not ready',
  other: 'Other',
};

async function currentLocation() {
  try {
    const l = await Location.getLastKnownPositionAsync({ maxAge: 120_000 });
    return l ? { lat: +l.coords.latitude.toFixed(6), lng: +l.coords.longitude.toFixed(6) } : null;
  } catch {
    return null;
  }
}

export function JobScreen({ job, onBack }: { job: DeliveryDoc; onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok' | 'warn'; text: string } | null>(null);
  const [cashCollected, setCashCollected] = useState(false);
  const [receivedBy, setReceivedBy] = useState('');
  const [otp, setOtp] = useState('');
  const [codeLocked, setCodeLocked] = useState(false);
  const [signature, setSignature] = useState<SignatureStrokes | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [reason, setReason] = useState<Exclude<ExceptionReason, 'missing_in_transit'> | null>(null);
  const [note, setNote] = useState('');
  const highValue = job.specialHandling.includes('high_value');
  const pickupStage = job.status === 'assigned' || job.status === 'en_route_to_pickup';

  /** Queue the action (durable), try to send now, then report what happened. */
  async function submit(type: DriverActionType, extra: Record<string, unknown> = {}, photoUris: string[] = []): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    const actionId = newActionId((n) => Crypto.getRandomBytes(n));
    try {
      await actionQueue.enqueue({ actionId, type, deliveryId: job.id, occurredAt: new Date().toISOString(), location: await currentLocation(), ...extra }, photoUris);
      await actionQueue.process();
      const snap = actionQueue.snapshot();
      const failed = snap.failed.find((f) => f.request.actionId === actionId);
      if (failed) {
        await actionQueue.dismissFailed(actionId);
        if (failed.code === 'OTP_LOCKED') setCodeLocked(true);
        setMsg({ tone: 'error', text: failed.message });
        return false;
      }
      if (snap.pending.some((p) => p.request.actionId === actionId)) {
        setMsg({ tone: 'warn', text: 'No signal — saved on the phone and will send automatically.' });
        return true;
      }
      setMsg({ tone: 'ok', text: 'Done.' });
      return true;
    } finally {
      setBusy(false);
    }
  }

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setMsg({ tone: 'error', text: 'Camera permission is needed for photos.' });
    const r = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: false });
    if (!r.canceled && r.assets[0]) setPhotos((p) => [...p, r.assets[0]!.uri].slice(0, 3));
  };

  const call = (phone: string) => void Linking.openURL(`tel:${phone}`);
  const navigate = (p: { lat: number; lng: number }) => void Linking.openURL(navigationUrl(p, Platform.OS === 'android' ? 'android' : 'other'));
  // Hub legs: first mile ends at the origin hub; last mile starts by collecting at the destination hub.
  const hub = job.status === 'picked_up' ? job.originHub : job.status === 'at_destination_hub' ? job.destinationHub : null;
  const stop = hub
    ? { title: job.status === 'picked_up' ? 'Drop at hub' : 'Collect at hub', contact: { name: hub.name, phone: config.dispatchPhone }, address: { line1: `${hub.name} (${hub.code})`, location: hub.location } as DeliveryDoc['pickup'] }
    : pickupStage || job.status === 'returning_to_sender'
      ? { title: 'Pickup', contact: job.sender, address: job.pickup }
      : { title: 'Delivery', contact: job.recipient, address: job.destination };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} accessibilityRole="button">
        <Text style={{ color: colors.brand, fontSize: 16 }}>‹ All jobs</Text>
      </Pressable>
      <Text style={s.muted}>{job.trackingNumber}</Text>
      <Text style={s.h1}>{PUBLIC_STATUS_LABELS[job.status]}</Text>
      <Text style={s.text}>{nextStep(job)}</Text>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Card>
        <Text style={s.h2}>{stop.title}</Text>
        <Text style={s.text}>{stop.contact.name}</Text>
        <Text style={s.text}>{stop.address.line1}</Text>
        {stop.address.line2 ? <Text style={s.muted}>{stop.address.line2}</Text> : null}
        {stop.address.landmark ? <Text style={s.muted}>Near {stop.address.landmark}</Text> : null}
        {stop.address.ghanaPostGps ? <Text style={s.muted}>GhanaPost GPS {stop.address.ghanaPostGps}</Text> : null}
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Button title="Navigate" onPress={() => navigate(stop.address.location)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={hub ? 'Call dispatch' : `Call ${stop.title === 'Pickup' ? 'sender' : 'recipient'}`}
              tone="secondary"
              disabled={!stop.contact.phone}
              onPress={() => call(stop.contact.phone)}
            />
          </View>
        </View>
      </Card>

      <Card>
        <Text style={s.h2}>Package</Text>
        {job.packages.map((p, i) => (
          <Text key={i} style={s.text}>
            {p.quantity} × {p.description} · {p.weightKg} kg
          </Text>
        ))}
        {job.specialHandling.length > 0 && <Text style={{ color: colors.warn, fontWeight: '700' }}>Handle: {job.specialHandling.join(', ')}</Text>}
        {job.instructions ? <Text style={s.muted}>“{job.instructions}”</Text> : null}
        {job.collectOnPickupPesewas > 0 && <Text style={{ color: colors.warn, fontWeight: '700' }}>Collect {formatGhs(job.collectOnPickupPesewas)} at pickup</Text>}
      </Card>

      {mode === 'view' && (
        <View style={{ gap: 10 }}>
          {job.status === 'assigned' && <Button title="Start job — heading to pickup" busy={busy} onPress={() => void submit('start_assignment')} />}
          {job.status === 'en_route_to_pickup' && (
            <>
              {job.collectOnPickupPesewas > 0 && (
                <View style={s.row}>
                  <Switch value={cashCollected} onValueChange={setCashCollected} accessibilityLabel="Cash collected" />
                  <Text style={s.text}>I have collected {formatGhs(job.collectOnPickupPesewas)}</Text>
                </View>
              )}
              <Button title="Scan package label" disabled={job.collectOnPickupPesewas > 0 && !cashCollected} onPress={() => setMode('scan')} />
            </>
          )}
          {job.status === 'out_for_delivery' && <Button title="Deliver package" onPress={() => setMode('deliver')} />}
          {job.status === 'returning_to_sender' && <Button title="Hand back to sender" onPress={() => setMode('return')} />}
          {hub && (
            <Notice tone="warn">
              {job.status === 'picked_up'
                ? `Hand the package to the ${hub.name} team. They scan it in; the job then leaves your list.`
                : `Collect the package from the ${hub.name} team. They scan it out to you, then deliver as usual.`}
            </Notice>
          )}
          {(pickupStage || job.status === 'out_for_delivery') && job.status !== 'assigned' && <Button title="Report a problem" tone="secondary" onPress={() => setMode('problem')} />}
          {config.dispatchPhone ? <Button title="Call dispatch" tone="secondary" onPress={() => call(config.dispatchPhone)} /> : null}
        </View>
      )}

      {mode === 'scan' && (
        <LabelScanner
          onCancel={() => setMode('view')}
          onCode={async (code) => {
            setMode('view');
            await submit('confirm_pickup', { scannedCode: code, cashCollected: job.collectOnPickupPesewas > 0 ? cashCollected : undefined });
          }}
        />
      )}

      {(mode === 'deliver' || mode === 'return') && (
        <Card>
          <Field label="Received by (name)" value={receivedBy} onChangeText={setReceivedBy} autoCapitalize="words" />
          {mode === 'deliver' && !codeLocked && (
            <Field label="Delivery code from the recipient's SMS" value={otp} onChangeText={(t) => setOtp(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" />
          )}
          {(mode === 'return' || codeLocked) && <SignaturePad onChange={setSignature} />}
          {(highValue || codeLocked || mode === 'return') && (
            <View style={{ gap: 8 }}>
              <Text style={s.label}>Photos {highValue || codeLocked ? '(required)' : '(optional)'}</Text>
              <View style={s.row}>
                {photos.map((u) => (
                  <Image key={u} source={{ uri: u }} style={{ width: 72, height: 72, borderRadius: 8 }} />
                ))}
              </View>
              <Button title="Take photo" tone="secondary" onPress={() => void takePhoto()} />
            </View>
          )}
          <Button
            title={mode === 'deliver' ? 'Confirm delivery' : 'Confirm return'}
            busy={busy}
            disabled={
              receivedBy.trim().length < 2 ||
              (mode === 'deliver' && !codeLocked && otp.length !== 6) ||
              ((mode === 'return' || codeLocked) && !signature) ||
              ((highValue || codeLocked) && photos.length === 0)
            }
            onPress={async () => {
              const ok =
                mode === 'deliver'
                  ? await submit('complete_delivery', { receivedByName: receivedBy.trim(), ...(codeLocked ? { signature } : { otp }) }, photos)
                  : await submit('complete_return', { receivedByName: receivedBy.trim(), signature }, photos);
              if (ok) onBack();
            }}
          />
          <Button title="Back" tone="secondary" onPress={() => setMode('view')} />
        </Card>
      )}

      {mode === 'problem' && (
        <Card>
          <Text style={s.h2}>What went wrong?</Text>
          {DRIVER_EXCEPTION_REASONS.map((r) => (
            <Pressable key={r} onPress={() => setReason(r)} accessibilityRole="radio" accessibilityState={{ checked: reason === r }}>
              <Text style={[s.text, { paddingVertical: 8, fontWeight: reason === r ? '700' : '400', color: reason === r ? colors.brand : colors.text }]}>
                {reason === r ? '● ' : '○ '}
                {REASON_TEXT[r]}
              </Text>
            </Pressable>
          ))}
          <Field label="Note (optional)" value={note} onChangeText={setNote} multiline />
          <Button
            title={pickupStage ? 'Report failed pickup' : 'Report failed delivery'}
            tone="danger"
            busy={busy}
            disabled={!reason}
            onPress={async () => {
              const ok = await submit(pickupStage ? 'report_pickup_failed' : 'report_delivery_failed', { reason, note: note.trim() || undefined });
              if (ok) onBack();
            }}
          />
          <Button title="Back" tone="secondary" onPress={() => setMode('view')} />
        </Card>
      )}
    </ScrollView>
  );
}
