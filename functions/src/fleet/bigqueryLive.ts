import { BigQuery, type Dataset } from '@google-cloud/bigquery';
import type { DriverPayStatement, ExpenseDoc, FuelLog, ShiftRecord } from '@courier/shared-types';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromDoc } from '../store/firestoreStore.js';
import type { BookingRecord } from '../store/types.js';
import type { BigQueryPort, BqField, BqRow, ExportSource } from './bigqueryExport.js';

export const BQ_DATASET = 'courier_analytics';
export const BQ_LOCATION = 'europe-west1';

export class LiveBigQuery implements BigQueryPort {
  private dataset: Promise<Dataset> | null = null;
  private readonly tables = new Set<string>();
  constructor(private readonly bq = new BigQuery()) {}

  private ds() {
    this.dataset ??= (async () => {
      const ds = this.bq.dataset(BQ_DATASET, { location: BQ_LOCATION });
      const [exists] = await ds.exists();
      if (!exists) await ds.create({ location: BQ_LOCATION });
      return ds;
    })();
    return this.dataset;
  }

  async loadDay(table: string, schema: BqField[], day: string, rows: BqRow[]) {
    const ds = await this.ds();
    if (!this.tables.has(table)) {
      const [exists] = await ds.table(table).exists();
      if (!exists) await ds.createTable(table, { schema: { fields: schema }, timePartitioning: { type: 'DAY' } });
      this.tables.add(table);
    }
    const partition = ds.table(`${table}$${day}`);
    if (rows.length === 0) {
      // Nothing that day: clear the partition in case an earlier run wrote rows that are now gone.
      await partition.delete().catch(() => undefined);
      return;
    }
    const file = join(tmpdir(), `${table}-${day}-${process.pid}.ndjson`);
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    try {
      await partition.load(file, { sourceFormat: 'NEWLINE_DELIMITED_JSON', writeDisposition: 'WRITE_TRUNCATE', schema: { fields: schema } });
    } finally {
      await fs.rm(file, { force: true });
    }
  }
}

export class FirestoreExportSource implements ExportSource {
  constructor(private readonly db: Firestore) {}
  private async q<T>(col: string, field: string, start: string | Timestamp, end: string | Timestamp, extra?: (q: FirebaseFirestore.Query) => FirebaseFirestore.Query) {
    let query: FirebaseFirestore.Query = this.db.collection(col);
    if (extra) query = extra(query);
    return (await query.where(field, '>=', start).where(field, '<', end).get()).docs.map((d) => ({ id: d.id, ...fromDoc<T>(d.data()) }));
  }
  bookingsCreated(s: Date, e: Date) {
    return this.q<BookingRecord>('deliveryRequests', 'createdAt', Timestamp.fromDate(s), Timestamp.fromDate(e));
  }
  async paymentsPaid(s: Date, e: Date) {
    const rows = await this.q<{ provider: string; channel?: string | null; amountPesewas: number; trackingNumber: string; businessId?: string | null; paidAt: Date }>(
      'payments',
      'paidAt',
      Timestamp.fromDate(s),
      Timestamp.fromDate(e),
      (q) => q.where('status', '==', 'succeeded'),
    );
    return rows.map((p) => ({ id: p.id, provider: p.provider, channel: p.channel ?? null, amountPesewas: p.amountPesewas, trackingNumber: p.trackingNumber, businessId: p.businessId ?? null, paidAt: p.paidAt }));
  }
  expensesIncurred(s: Date, e: Date) {
    return this.q<ExpenseDoc>('expenses', 'incurredAt', s.toISOString(), e.toISOString());
  }
  fuelLogs(s: Date, e: Date) {
    return this.q<FuelLog>('fuelLogs', 'filledAt', s.toISOString(), e.toISOString());
  }
  shiftsStarted(s: Date, e: Date) {
    return this.q<ShiftRecord>('shifts', 'startedAt', s.toISOString(), e.toISOString());
  }
  statementsPaid(s: Date, e: Date) {
    return this.q<DriverPayStatement>('driverPayments', 'paidAt', s.toISOString(), e.toISOString());
  }
}
