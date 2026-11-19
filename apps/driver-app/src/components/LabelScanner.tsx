import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Field, s } from './ui';

/** Scans the QR/barcode on the package label; manual entry fallback for damaged labels. */
export function LabelScanner({ onCode, onCancel }: { onCode: (code: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [done, setDone] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      {permission?.granted ? (
        <CameraView
          style={{ height: 320, borderRadius: 12, overflow: 'hidden' }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128'] }}
          onBarcodeScanned={({ data }) => {
            if (done) return;
            setDone(true);
            onCode(data);
          }}
        />
      ) : (
        <Button title="Allow camera to scan" onPress={() => void requestPermission()} />
      )}
      <Text style={s.muted}>Or type the tracking number from the label:</Text>
      <Field label="Tracking number" autoCapitalize="characters" value={manual} onChangeText={setManual} />
      <Button title="Use this number" tone="secondary" disabled={manual.trim().length < 10} onPress={() => onCode(manual.trim())} />
      <Button title="Cancel" tone="secondary" onPress={onCancel} />
    </View>
  );
}
