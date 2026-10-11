/**
 * Offline end-to-end demo: charge -> fee split -> refund -> payout -> reconciliation.
 * Needs only Postgres + Redis (`docker compose up -d`); no provider keys, no internet.
 * WARNING: it TRUNCATES the ledger tables of the database in DATABASE_URL.
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DbService } from '../db/db.service';
import { SimulatedProvider } from '../providers/simulated.provider';

// Demo-friendly settings (set before the app reads its config).
process.env.QUEUE_PREFIX = `demo-${randomUUID().slice(0, 8)}`;
process.env.SCHEDULERS_ENABLED = 'false';
process.env.PAYOUT_HOLD_DAYS ??= '2';
process.env.PAYOUT_RESERVE_MINOR ??= '500';
process.env.WEBHOOK_BACKOFF_MS ??= '100';
process.env.PAYOUT_RETRY_BACKOFF_MS ??= '100';

const money = (minor: number, cur = 'USD') => `${cur} ${(minor / 100).toFixed(2).padStart(9)}`;
const title = (s: string) => console.log(`\n\x1b[1m\x1b[36m== ${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✔\x1b[0m ${s}`);

async function main() {
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const sim = app.get(SimulatedProvider);
  sim.setBaseUrl(url);
  const db = app.get(DbService);
  await db.query(`TRUNCATE accounts, journal_entries, postings, account_balances, payments, refunds, idempotency_keys,
    webhook_events, payouts, reconciliation_reports, sim_provider_transactions RESTART IDENTITY CASCADE`);

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const balances = async (heading: string) => {
    const tb = await call('GET', '/ledger/trial-balance');
    console.log(`  ${heading}`);
    for (const a of tb.accounts) console.log(`    ${a.code.padEnd(34)} ${money(a.balance, a.currency)}`);
    console.log(`    ledger balanced (all postings sum to 0, caches match): ${tb.balanced ? '\x1b[32myes\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
  };

  title('1. Charge: two buyers pay Acme Bikes 100.00 and 50.00 (platform fee 10%)');
  const key1 = randomUUID();
  const body = { buyerId: 'buyer_ada', sellerId: 'acme_bikes', amount: 10000, currency: 'USD', capture: true };
  const p1 = await call('POST', '/payments', body, { 'idempotency-key': key1 });
  const replay = await fetch(url + '/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key1 }, body: JSON.stringify(body) });
  ok(`payment ${p1.id.slice(0, 8)} ${p1.status}, fee ${money(p1.feeAmount)}`);
  ok(`replay with the same Idempotency-Key -> ${replay.status}, Idempotent-Replayed: ${replay.headers.get('idempotent-replayed')}, same id: ${((await replay.json()) as any).id === p1.id}`);
  const p2 = await call('POST', '/payments', { buyerId: 'buyer_grace', sellerId: 'acme_bikes', amount: 5000, currency: 'USD', capture: true }, { 'idempotency-key': randomUUID() });
  ok(`payment ${p2.id.slice(0, 8)} ${p2.status}, fee ${money(p2.feeAmount)}`);
  await balances('Balances after two charges (fee split: seller 90%, platform 10%):');

  title('2. Refund: 40.00 of the first payment (fee returned pro rata)');
  const refunded = await call('POST', `/payments/${p1.id}/refunds`, { amount: 4000 }, { 'idempotency-key': randomUUID() });
  ok(`payment ${refunded.id.slice(0, 8)} is now ${refunded.status}, refunded ${money(refunded.refundedAmount)}`);
  await balances('Balances after the refund:');

  title('3. Signed webhooks: the simulated provider confirmed both captures and the refund');
  await sim.flush();
  await waitFor(async () => ((await db.query("SELECT 1 FROM webhook_events WHERE status <> 'processed'")).rowCount === 0 ? true : undefined), 'webhooks processed');
  const wh = await db.query('SELECT type, count(*)::int AS n FROM webhook_events GROUP BY type ORDER BY type');
  for (const r of wh.rows) ok(`${r.type} x${r.n} (HMAC verified, deduped, processed via BullMQ)`);

  title('4. Payout: funds are held for 2 days, then paid out minus a 5.00 reserve');
  const today = await call('POST', '/payouts/run', {});
  console.log(`  Run now:      ${today[0].skipped}  (matured ${money(today[0].matured)})`);
  const later = await call('POST', '/payouts/run', { asOf: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  const line = later[0];
  console.log(`  Run in +3d:   matured ${money(line.matured)} - debits ${money(line.debits)} - reserve ${money(line.reserve)} = payout ${money(line.payoutAmount)}`);
  const paid = await waitFor(async () => {
    const x = await call('GET', `/payouts/${line.payoutId}`);
    return x.status === 'paid' ? x : undefined;
  }, 'payout to be paid');
  ok(`payout ${paid.id.slice(0, 8)} ${paid.status} (pending -> paid via payout.paid webhook)`);
  await balances('Balances after payout:');

  title('5. Reconciliation: provider-reported transactions vs. ledger');
  const date = new Date().toISOString().slice(0, 10);
  const clean = await call('GET', `/reports/reconciliation?date=${date}`);
  ok(`${date}: ${clean.summary.matched}/${clean.summary.providerTransactions} matched, ${clean.summary.mismatches} mismatches`);
  console.log('  Now the provider "disagrees": one charge amount changed, one unknown charge appears...');
  await sim.tamper({ setAmount: { id: p2.providerRef, amount: 4999 } });
  await sim.tamper({ add: { id: 'sim_ch_unknown', type: 'charge', amount: 1234, currency: 'USD', createdAt: new Date().toISOString() } });
  const bad = await call('GET', `/reports/reconciliation?date=${date}`);
  for (const m of bad.mismatches) {
    console.log(`  \x1b[33m!\x1b[0m ${m.type.padEnd(20)} ${m.kind} ${m.ref.slice(0, 18).padEnd(18)} provider=${m.providerAmount ?? '-'} ledger=${m.ledgerAmount ?? '-'}`);
  }

  title('Final trial balance');
  await balances('All accounts:');
  console.log();
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
