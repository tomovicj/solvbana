/**
 * Harvest failing mainnet signatures into the fixture corpus.
 *
 * Usage: `node --env-file-if-exists=.env scripts/harvest.ts [--target 40] [--blocks 400]`
 *
 * Walks recent slots, keeps transactions whose `meta.err` is non-null, and fills
 * a per-category quota so the rare buckets survive. Left to itself the corpus
 * would be almost entirely Anchor constraint failures, which are far and away the
 * most common failure on chain and the least in need of a regression test.
 *
 * Run this by hand, never from CI or the test suite: the suite reads the cached
 * fixtures so it stays offline and deterministic. `getBlock` is heavy and public
 * endpoints rate-limit it hard — this wants a paid endpoint.
 */
import { CATEGORIES, classify, distinctnessKey, type Category } from './lib/classify.ts';
import { RpcCallError, rpcCall, rpcUrl, sleep } from './lib/rpc.ts';
import { readManifest } from './lib/manifest.ts';
import { record } from './lib/record.ts';

interface BlockTransaction {
  meta: { err: unknown; logMessages: readonly string[] | null } | null;
  transaction: { signatures: readonly string[] };
}

interface Block {
  transactions?: readonly BlockTransaction[];
}

function numericArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const target = numericArg('--target', 40);
const maxBlocks = numericArg('--blocks', 500);
/**
 * How many fixtures may share a distinctness key. Two keeps a second example of
 * each failure without letting one busy program dominate the corpus.
 */
const perKeyCap = numericArg('--per-key', 2);

/** Spread the target across categories, so no single bucket can crowd out the rest. */
function quotaPerCategory(): Map<Category, number> {
  const per = Math.max(1, Math.ceil(target / CATEGORIES.length));
  return new Map(CATEGORIES.map((category) => [category, per]));
}

const url = rpcUrl();
const existing = await readManifest();

const quota = quotaPerCategory();
const counts = new Map<Category, number>(CATEGORIES.map((category) => [category, 0]));
const seen = new Set(existing.entries.map((entry) => entry.signature));
const keyCounts = new Map<string, number>();
for (const entry of existing.entries) {
  counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  keyCounts.set(entry.distinctnessKey, (keyCounts.get(entry.distinctnessKey) ?? 0) + 1);
}

function wanted(category: Category, key: string): boolean {
  if ((counts.get(category) ?? 0) >= (quota.get(category) ?? 0)) return false;
  return (keyCounts.get(key) ?? 0) < perKeyCap;
}

function totalRecorded(): number {
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

const head = await rpcCall<number>(url, 'getSlot', [{ commitment: 'finalized' }]);
console.log(`Harvesting from slot ${String(head)} backwards, up to ${String(maxBlocks)} blocks.`);
console.log(`Target ${String(target)} fixtures; ${String(totalRecorded())} already in the corpus.`);

let scanned = 0;
let added = 0;

for (let slot = head; slot > head - maxBlocks && totalRecorded() < target; slot -= 1) {
  let block: Block | null;
  try {
    block = await rpcCall<Block | null>(url, 'getBlock', [
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
    // Skipped slots are normal and not an error worth stopping for; anything
    // else (rate limiting, a disabled method) is worth surfacing immediately.
    if (error instanceof RpcCallError && error.rpcError.code === -32009) continue;
    if (error instanceof RpcCallError && error.rpcError.code === -32007) continue;
    throw error;
  }

  if (block === null) continue;
  scanned += 1;

  for (const transaction of block.transactions ?? []) {
    if (totalRecorded() >= target) break;

    const meta = transaction.meta;
    const signature = transaction.transaction.signatures[0];
    if (meta === null || meta.err === null || signature === undefined) continue;
    if (seen.has(signature)) continue;

    const input = { err: meta.err, logs: meta.logMessages ?? [] };
    const category = classify(input);
    if (category === null) continue;

    const key = distinctnessKey(input);
    if (!wanted(category, key)) continue;

    // Re-fetch through getTransaction: the corpus stores that response shape,
    // which carries slot and blockTime that a block entry does not.
    try {
      const entry = await record(signature, 'TODO: describe what actually went wrong.');
      seen.add(signature);
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
      keyCounts.set(entry.distinctnessKey, (keyCounts.get(entry.distinctnessKey) ?? 0) + 1);
      added += 1;
      console.log(`  + ${entry.category.padEnd(20)} ${signature}`);
    } catch (error) {
      console.warn(`  ! skipped ${signature}: ${error instanceof Error ? error.message : ''}`);
    }

    await sleep(120);
  }
}

console.log(`\nScanned ${String(scanned)} blocks, added ${String(added)} fixtures.`);
for (const category of CATEGORIES) {
  const count = counts.get(category) ?? 0;
  const need = quota.get(category) ?? 0;
  const flag = count < need ? '  <- under quota' : '';
  console.log(`  ${category.padEnd(20)} ${String(count)}/${String(need)}${flag}`);
}
console.log('\nFill in the `note` field for each new entry in fixtures/manifest.json by hand.');
