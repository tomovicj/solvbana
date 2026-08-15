import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Category } from './classify.ts';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
export const TRANSACTIONS_DIR = join(FIXTURES_DIR, 'transactions');
export const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');

/**
 * One corpus entry.
 *
 * The expectations are the spec, so they are hand-checked rather than generated
 * from the parser's own output — a manifest written by the code under test would
 * assert nothing. The harvester fills in what it can read directly from the
 * ledger and leaves `note` for a human.
 */
export interface FixtureEntry {
  signature: string;
  category: Category;
  /** File name under `fixtures/transactions/`. */
  file: string;
  /** Index of the failing instruction, or `null` for a transaction-level error. */
  failingInstructionIndex: number | null;
  /** Expected `TransactionError.kind` from the ingest parser. */
  errorKind: string;
  /** Expected `InstructionError.kind`, when the failure names an instruction. */
  instructionErrorKind: string | null;
  expectTruncatedLogs: boolean;
  /** Groups fixtures that exercise the same failure, so the harvester can cap repeats. */
  distinctnessKey: string;
  /** What actually went wrong, in one line. Written by hand. */
  note: string;
}

export interface Manifest {
  entries: FixtureEntry[];
}

export async function readManifest(): Promise<Manifest> {
  try {
    const contents = await readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(contents) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    throw error;
  }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  const sorted = [...manifest.entries].sort((a, b) => a.signature.localeCompare(b.signature));
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify({ entries: sorted }, null, 2)}\n`, 'utf8');
}

export async function writeTransactionFixture(signature: string, result: unknown): Promise<string> {
  const file = `${signature}.json`;
  await mkdir(TRANSACTIONS_DIR, { recursive: true });
  await writeFile(join(TRANSACTIONS_DIR, file), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return file;
}
