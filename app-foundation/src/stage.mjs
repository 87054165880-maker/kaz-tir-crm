import { buildPreview } from './preview.mjs';

// Trusted LOCAL test adapter, not an authenticated API. All SQL uses parameters.
// No promotion into application trips/payments; no host/credentials are accepted here.
export async function stageSnapshot(db, input) {
  const preview = buildPreview(input);
  const t = preview.tenantId, b = preview.batchId;
  return db.transaction(async tx => {
    const inserted = await tx.query(`
      INSERT INTO import_staging.batches
        (tenant_id, id, source_spreadsheet_id, snapshot_id, content_hash,
         mapping_version, default_currency, source_coverage, report)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT DO NOTHING RETURNING id`,
    [t, b, preview.sourceSpreadsheetId, preview.snapshotId, preview.contentHash,
      preview.mappingVersion, preview.defaultCurrency, JSON.stringify(preview.coverage), JSON.stringify(preview)]);
    if (!inserted.rows.length) {
      const existing = await tx.query(
        'SELECT content_hash FROM import_staging.batches WHERE tenant_id=$1 AND id=$2', [t, b]);
      if (existing.rows[0]?.content_hash !== preview.contentHash) throw new Error('SNAPSHOT_CONTENT_CONFLICT: use a new snapshotId; existing data was not overwritten');
      return { reused: true, batchId: b, summary: preview.summary };
    }
    for (const row of preview.rows) {
      await tx.query(`INSERT INTO import_staging.source_rows
        (tenant_id,batch_id,id,sheet_name,row_number,source_key,raw,outcome,issues)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t,b,row.id,row.sheet,row.rowNumber,row.sourceKey,JSON.stringify(row.raw),row.outcome,JSON.stringify(row.issues)]);
    }
    for (const trip of preview.trips) {
      await tx.query(`INSERT INTO import_staging.trip_candidates
        (tenant_id,batch_id,source_row_id,trip_id,source_status,facts) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t,b,trip.sourceRowId,trip.tripId,trip.facts.status,JSON.stringify(trip.facts)]);
    }
    for (const manual of preview.manualSettlements) {
      await tx.query(`INSERT INTO import_staging.manual_settlement_candidates
        (tenant_id,batch_id,trip_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5)`,
      [t,b,manual.tripId,manual.amountMinor,manual.currency]);
    }
    for (const payment of preview.agentPayments) {
      await tx.query(`INSERT INTO import_staging.agent_payment_candidates
        (tenant_id,batch_id,source_row_id,source_payment_id,trip_id,payment_date,payment_type,amount_minor,currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t,b,payment.sourceRowId,payment.sourcePaymentId,payment.tripId,payment.paymentDate,
        payment.paymentType,payment.amountMinor,payment.currency]);
    }
    return { reused: false, batchId: b, summary: preview.summary };
  });
}
