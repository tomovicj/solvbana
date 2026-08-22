/**
 * Harvest failing mainnet signatures into the fixture corpus.
 *
 * Usage: `node --env-file-if-exists=.env scripts/harvest.ts [--target 40] [--blocks 400]`
 *
 * `--want ConstraintSeeds,ConstraintHasOne` narrows a run to specific Anchor
 * errors, matched against the `Error Code:` line the program printed about
 * itself and never against the reserved code range — which is the guess the
 * engine refuses to make and would pick up every other 2xxx variant besides.
 * Use it to fill a hole a general harvest cannot reach: the rare variants are
 * rare precisely because they mean a broken client, which then gets fixed.
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
import {
  CATEGORIES,
  classify,
  distinctnessKey,
  loggedAnchorErrorName,
  type Category,
} from './lib/classify.ts';
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

/**
 * Anchor error names to hold out for, or empty for an ordinary harvest.
 *
 * A targeted run bypasses the category quota: the point is to reach a variant
 * the quota would fill up long before finding, so capping it by category would
 * defeat the request. The distinctness cap still applies, since two examples of
 * one program's `ConstraintSeeds` are still one code path.
 */
function listArg(flag: string): string[] {
  const index = process.argv.indexOf(flag);
  if (index < 0) return [];
  return (process.argv[index + 1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const want = new Set(listArg('--want'));

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

function wanted(category: Category, key: string, anchorName: string | null): boolean {
  if (want.size > 0) {
    // A targeted run answers only the question it was asked, and the category
    // quota is not that question.
    return anchorName !== null && want.has(anchorName) && (keyCounts.get(key) ?? 0) < perKeyCap;
  }
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

/**
 * A targeted run stops when it has found what it was asked for, not when the
 * corpus reaches `target` — the corpus is already full, which is why the hole
 * exists in the first place.
 */
function done(): boolean {
  return want.size > 0 ? added >= target : totalRecorded() >= target;
}

for (let slot = head; slot > head - maxBlocks && !done(); slot -= 1) {
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
    if (done()) break;

    const meta = transaction.meta;
    const signature = transaction.transaction.signatures[0];
    if (meta === null || meta.err === null || signature === undefined) continue;
    if (seen.has(signature)) continue;

    const input = { err: meta.err, logs: meta.logMessages ?? [] };
    const category = classify(input);
    if (category === null) continue;

    const key = distinctnessKey(input);
    if (!wanted(category, key, loggedAnchorErrorName(input.logs))) continue;

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

if (want.size > 0) {
  // Report the search, not just the result. A targeted harvest that finds
  // nothing is a measurement — the variant is rare on mainnet — and recording
  // how far it looked is what makes that claim checkable later.
  console.log(
    `Targeted ${[...want].join(', ')} across ${String(scanned)} blocks: ` +
      `${String(added)} found.`,
  );
  process.exit(0);
}

for (const category of CATEGORIES) {
  const count = counts.get(category) ?? 0;
  const need = quota.get(category) ?? 0;
  const flag = count < need ? '  <- under quota' : '';
  console.log(`  ${category.padEnd(20)} ${String(count)}/${String(need)}${flag}`);
}
console.log('\nFill in the `note` field for each new entry in fixtures/manifest.json by hand.');
