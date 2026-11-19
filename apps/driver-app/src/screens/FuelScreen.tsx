import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, ScrollView, Switch, Text, View } from 'react-native';
import { Button, Field, Notice, s } from '../components/ui';
import { parseOdometer } from '../core/jobs';
import { api } from '../services/api';
import { uploadReceipt } from '../services/uploads';

/** Record a fill-up for the shift's vehicle (sent to finance as a fuel expense). */
export function FuelScreen({ onBack }: { onBack: () => void }) {
  const [litres, setLitres] = useState('');
  const [amount, setAmount] = useState('');
  const [odometer, setOdometer] = useState('');
  const [station, setStation] = useState('');
  const [fullTank, setFullTank] = useState(true);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setMsg({ tone: 'error', text: 'Camera permission is needed for the receipt photo.' });
    const r = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!r.canceled && r.assets[0]) setPhoto(r.assets[0].uri);
  };

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const odo = parseOdometer(odometer);
      if ('error' in odo) throw new Error(odo.error);
      const l = Number(litres.replace(',', '.'));
      const cedis = Number(amount.replace(/,/g, ''));
      if (!(l > 0)) throw new Error('Enter the litres.');
      if (!(cedis > 0)) throw new Error('Enter the amount paid.');
      if (!photo) throw new Error('Take a photo of the receipt.');
      const receiptKey = await uploadReceipt(photo);
      await api.logFuel({ litres: l, amountPesewas: Math.round(cedis * 100), odometerKm: odo.km, fullTank, ...(station.trim() ? { station: station.trim() } : {}), receiptKey });
      setMsg({ tone: 'ok', text: 'Fuel recorded. Thank you.' });
      setLitres('');
      setAmount('');
      setPhoto(null);
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Button title="‹ Back to jobs" tone="secondary" onPress={onBack} />
      <Text style={s.h1}>Record fuel</Text>
      <Text style={s.muted}>For the vehicle of your current shift. Needs a signal; the receipt photo is required.</Text>
      <Field label="Litres" keyboardType="decimal-pad" value={litres} onChangeText={setLitres} />
      <Field label="Amount paid (GH₵)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
      <Field label="Odometer (km)" keyboardType="number-pad" value={odometer} onChangeText={setOdometer} />
      <Field label="Fuel station (optional)" value={station} onChangeText={setStation} />
      <View style={s.row}>
        <Switch value={fullTank} onValueChange={setFullTank} />
        <Text style={s.text}>Filled the tank to full</Text>
      </View>
      {photo ? <Image source={{ uri: photo }} style={{ width: 160, height: 160, borderRadius: 8 }} /> : null}
      <Button title={photo ? 'Retake receipt photo' : 'Take receipt photo'} tone="secondary" onPress={() => void takePhoto()} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button title="Save fuel record" busy={busy} disabled={busy} onPress={() => void save()} />
    </ScrollView>
  );
}
