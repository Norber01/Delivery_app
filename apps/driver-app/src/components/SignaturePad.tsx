import type { SignatureStrokes } from '@courier/shared-types';
import { useRef, useState } from 'react';
import { PanResponder, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { normaliseStrokes } from '../core/signature';
import { Button, colors, s } from './ui';

/** Finger signature capture; emits normalised strokes (stored as vectors, not images). */
export function SignaturePad({ onChange }: { onChange: (s: SignatureStrokes | null) => void }) {
  const [strokes, setStrokes] = useState<{ x: number; y: number }[][]>([]);
  const size = useRef({ w: 1, h: 1 });
  const current = useRef<{ x: number; y: number }[]>([]);

  const emit = (all: { x: number; y: number }[][]) => {
    const n = normaliseStrokes(all, size.current.w, size.current.h);
    onChange(n.reduce((c, x) => c + x.length, 0) >= 10 ? n : null);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        current.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
        setStrokes((prev) => [...prev, current.current]);
      },
      onPanResponderMove: (e) => {
        current.current.push({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
        setStrokes((prev) => [...prev.slice(0, -1), [...current.current]]);
      },
      onPanResponderRelease: () => setStrokes((prev) => (emit(prev), prev)),
    }),
  ).current;

  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>Recipient signature</Text>
      <View
        {...responder.panHandlers}
        onLayout={(e: LayoutChangeEvent) => (size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        style={{ height: 180, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: '#fff' }}
        accessibilityLabel="Signature area. Ask the recipient to sign with a finger."
      >
        <Svg width="100%" height="100%">
          {strokes.map((st, i) => (
            <Polyline key={i} points={st.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
      </View>
      <Button
        title="Clear signature"
        tone="secondary"
        onPress={() => {
          setStrokes([]);
          onChange(null);
        }}
      />
    </View>
  );
}
