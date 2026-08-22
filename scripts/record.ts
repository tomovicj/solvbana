/**
 * Record one signature into the fixture corpus.
 *
 * Usage: `node --env-file-if-exists=.env scripts/record.ts <signature> [note]`
 *
 * This is the path for a signature that arrives in a bug report. The harvester
 * finds failures in bulk; this pins a specific one.
 */
import { record } from './lib/record.ts';

const signature = process.argv[2];
if (signature === undefined) {
  console.error('Usage: node scripts/record.ts <signature> [note]');
  process.exit(1);
}

const note = process.argv[3] ?? 'TODO: describe what actually went wrong.';
const entry = await record(signature, note);
console.log(`Recorded ${entry.signature} as ${entry.category}.`);
