/**
 * Measure what the engine actually reaches on live mainnet failures.
 *
 * Usage: `pnpm coverage [--target 200] [--blocks 60]`
 *
 * The fixture corpus is a hand-checked regression suite: one of each failure
 * shape, so every code path has a test. That makes it deliberately unlike real
 * traffic, and its confidence distribution is therefore *not* a statement about
 * the tool's reach. Reading it as one is how a project talks itself into
 * believing it covers more than it does.
 *
 * This is the other measurement. It samples whatever mainnet is failing right
 * now, runs the full engine over each, and reports where the answers land and
 * what is blocking the ones that do not. The two numbers are expected to differ
 * sharply, and the gap is the point.
 *
 * Manual only, never CI: `getBlock` is heavy and wants a paid endpoint, and the
 * output is a report to read rather than an assertion to pass.
 */
import {
  createAccountSource,
  diagnose,
  reviveRawTransaction,
  type Confidence,
  type Diagnosis,
  type RawTransaction,
  type TransactionSource,
} from '@solvbana/core';
import { RpcCallError, rpcCall, rpcUrl, sleep } from './lib/rpc.ts';

interface BlockTransaction {
  meta: { err: unknown; logMessages: readonly string[] | null } | null;
  transaction: { signatures: readonly string[] };
}

interface Block {
  transactions?: readonly BlockTransaction[];
  blockTime?: number | null;
  parentSlot?: number;
}

function numericArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const target = numericArg('--target', 200);
const maxBlocks = numericArg('--blocks', 60);
/**
 * Pause between diagnoses, in milliseconds.
 *
 * Each one costs a handful of account reads on top of the block fetch, so a few
 * hundred of them will rate-limit an endpoint that serves a single diagnosis
 * without complaint. Pacing is cheaper than discovering the ceiling at 429.
 */
const delay = numericArg('--delay', 120);
/**
 * Most failures taken from any one block.
 *
 * A busy block is thousands of failures from a handful of arbitrage programs,
 * so an uncapped sample is a portrait of whatever was losing money in that
 * second rather than of mainnet. Spreading across blocks is the same reason the
 * harvester caps repeats by distinctness key.
 */
const perBlock = numericArg('--per-block', 8);
const url = rpcUrl();

/**
 * Fetch a block, backing off when the endpoint says to.
 *
 * A skipped slot is normal and returns nothing. A 429 is the endpoint asking
 * for room rather than an error, so it is waited out and retried; anything else
 * stops the run, because a report built from partial data quietly understates
 * whatever failed to load.
 */
async function fetchBlock(slot: number): Promise<Block | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcCall<Block | null>(url, 'getBlock', [
        slot,
        {
          encoding: 'json',
          transactionDetails: 'full',
          rewards: false,
          maxSupportedTransactionVersion: 0,
          commitment: 'finalized',
        },
      ]);
    } catch (error) {
      if (error instanceof RpcCallError && [-32007, -32009].includes(error.rpcError.code)) {
        return null;
      }
      const rateLimited = error instanceof Error && error.message.includes('429');
      if (!rateLimited || attempt >= 5) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * A source over a transaction already in hand.
 *
 * The block carries the whole record, so re-fetching each signature through
 * `getTransaction` would double the RPC bill to learn nothing. The shape has to
 * be revived the way the client would produce it, bigints included, or the
 * engine sees a shape production never sends.
 */
function sourceFor(raw: RawTransaction): TransactionSource {
  return { fetchTransaction: () => Promise.resolve({ kind: 'found', raw, endpoint: 'primary' }) };
}

/**
 * Why this diagnosis did not name the failure.
 *
 * Classified from what resolution recorded rather than from the error text, so
 * the buckets stay tied to decisions the engine actually made. Ordered
 * most-specific first: a closed ProgramData is also a program with no IDL, and
 * the first reason is the one that stopped the cascade.
 */
function blockedBy(diagnosis: Diagnosis): string {
  const resolution = diagnosis.finding?.resolution;
  if (diagnosis.finding?.program === null) return 'no failing program identified';
  if (resolution === undefined) {
    const failed = diagnosis.reasons.find((reason) =>
      reason.startsWith('Source resolution failed'),
    );
    return failed === undefined ? 'resolution did not run' : 'resolution failed (see reasons)';
  }

  switch (resolution.deployment.kind) {
    case 'upgraded-since':
      return 'program redeployed since the transaction';
    case 'closed':
      return 'ProgramData closed';
    case 'unavailable':
      return 'deployment unreadable';
    default:
      break;
  }

  if (resolution.idl === null) return 'program publishes no IDL, and none was uploaded';
  return 'IDL resolved but does not declare this code';
}

const accounts = createAccountSource({ rpcUrl: url });
const head = await rpcCall<number>(url, 'getSlot', [{ commitment: 'finalized' }]);

console.log(
  `Sampling up to ${String(target)} failures from ${String(maxBlocks)} blocks back from ${String(head)}.`,
);

const confidences = new Map<Confidence, number>();
const blockers = new Map<string, number>();
const naming = new Map<string, number>();
let sampled = 0;
let scanned = 0;

for (let slot = head; slot > head - maxBlocks && sampled < target; slot -= 1) {
  const block = await fetchBlock(slot);

  if (block === null) continue;
  scanned += 1;
  let fromThisBlock = 0;

  for (const entry of block.transactions ?? []) {
    if (sampled >= target || fromThisBlock >= perBlock) break;

    const signature = entry.transaction.signatures[0];
    if (entry.meta === null || entry.meta.err === null || signature === undefined) continue;

    // A block entry carries no slot or blockTime of its own, and the engine
    // needs the slot to decide whether the deployed binary is the one that ran.
    const raw = reviveRawTransaction({
      ...(entry as unknown as Record<string, unknown>),
      slot,
      blockTime: block.blockTime ?? null,
    });

    const diagnosis = await diagnose(signature, { source: sourceFor(raw), accounts });
    sampled += 1;
    fromThisBlock += 1;
    if (delay > 0) await sleep(delay);

    if (sampled % 50 === 0) process.stderr.write(`  … ${String(sampled)} diagnosed\n`);

    confidences.set(diagnosis.confidence, (confidences.get(diagnosis.confidence) ?? 0) + 1);

    const named = diagnosis.finding?.error.naming ?? 'none';
    naming.set(named, (naming.get(named) ?? 0) + 1);

    if (diagnosis.finding?.error.name === null) {
      const reason = blockedBy(diagnosis);
      blockers.set(reason, (blockers.get(reason) ?? 0) + 1);
    }
  }
}

const share = (count: number): string => `${((count / sampled) * 100).toFixed(1)}%`;

console.log(`\n${String(sampled)} failures diagnosed across ${String(scanned)} blocks.\n`);

console.log('confidence');
for (const [level, count] of [...confidences].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${level.padEnd(14)} ${String(count).padStart(5)}  ${share(count)}`);
}

console.log('\nwhere the error name came from');
for (const [source, count] of [...naming].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${source.padEnd(16)} ${String(count).padStart(5)}  ${share(count)}`);
}

if (blockers.size > 0) {
  console.log('\nwhat blocked the ones left unnamed');
  for (const [reason, count] of [...blockers].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${share(count).padStart(6)}  ${reason}`);
  }
}
