import { formatGhs } from '@courier/shared-utils';
import { ScrollView, Text, View } from 'react-native';
import { Button, Card, Notice, s } from '../components/ui';
import { usePay } from '../services/hooks';

const STATUS = { draft: 'Being prepared', approved: 'Approved — payment coming', paid: 'Paid' } as const;

/** Monthly pay statements, the pay rates, and customer cash still to hand in. */
export function PayScreen({ uid, onBack }: { uid: string; onBack: () => void }) {
  const { statements, cash, rules } = usePay(uid);
  const held = (cash?.collectedPesewas ?? 0) - (cash?.remittedPesewas ?? 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Button title="‹ Back to jobs" tone="secondary" onPress={onBack} />
      <Text style={s.h1}>My pay</Text>
      {held > 0 && <Notice tone="warn">You are holding {formatGhs(held)} of customer cash. Hand it in at the warehouse or by Mobile Money as agreed.</Notice>}
      {rules && (
        <Card>
          <Text style={s.h2}>Rates</Text>
          <Text style={s.text}>Per day worked: {formatGhs(rules.dailyRatePesewas)}</Text>
          <Text style={s.text}>Pickup to warehouse: {formatGhs(rules.perJobPesewas.first_mile)} · Delivery from warehouse: {formatGhs(rules.perJobPesewas.last_mile)} · Door to door: {formatGhs(rules.perJobPesewas.direct)}</Text>
          <Text style={s.text}>Intercity trip: {formatGhs(rules.perLinehaulTripPesewas)}</Text>
        </Card>
      )}
      {statements.length === 0 && <Text style={s.muted}>No statements yet. They are prepared after each month.</Text>}
      {statements.map((st) => (
        <Card key={st.id}>
          <View style={s.row}>
            <Text style={[s.h2, { flex: 1 }]}>{st.period}</Text>
            <Text style={s.h2}>{formatGhs(st.grossPesewas)}</Text>
          </View>
          <Text style={s.muted}>{STATUS[st.status]}{st.payout ? ` · ${st.payout.method.replace('_', ' ')} ${st.payout.reference}` : ''}</Text>
          {st.lines.map((l) => (
            <Text key={l.label} style={s.text}>
              {l.label}: {l.quantity} × {formatGhs(l.ratePesewas)} = {formatGhs(l.amountPesewas)}
            </Text>
          ))}
          {st.adjustments.map((a, i) => (
            <Text key={i} style={s.text}>
              {a.label}: {formatGhs(a.amountPesewas)}
            </Text>
          ))}
          <Text style={s.muted}>{st.daysWorked} day(s) · {st.kmDriven} km</Text>
        </Card>
      ))}
    </ScrollView>
  );
}
