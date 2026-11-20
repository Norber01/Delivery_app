import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

/** Black text and links, a bright yellow for the main action on every screen (easy to find on a sunny road). */
export const colors = { brand: '#1a1a1a', brandDark: '#000000', accent: '#ffd919', bg: '#f3f3f1', text: '#141414', muted: '#6b6b6b', border: '#e4e4e0', danger: '#b91c1c', warn: '#92400e', warnBg: '#fff3c4' };

export function Button({ title, onPress, disabled, busy, tone = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean; tone?: 'primary' | 'secondary' | 'danger' }) {
  const bg = tone === 'primary' ? colors.accent : '#fff';
  const fg = tone === 'primary' ? '#000' : tone === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.button, { backgroundColor: bg, borderColor: tone === 'primary' ? bg : colors.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={s.input} accessibilityLabel={label} {...props} />
    </View>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  const c = { error: ['#fee2e2', colors.danger], warn: [colors.warnBg, colors.warn], ok: ['#dcfce7', colors.brandDark] }[tone];
  return <Text style={[s.notice, { backgroundColor: c[0], color: c[1] }]}>{children}</Text>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text },
  h2: { fontSize: 17, fontWeight: '600', color: colors.text },
  text: { fontSize: 15, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, backgroundColor: '#fff', color: colors.text },
  button: { minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, gap: 8, borderWidth: 1, borderColor: colors.border },
  notice: { padding: 10, borderRadius: 10, fontSize: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
