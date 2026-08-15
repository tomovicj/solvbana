/** Fetch one signature and add it to the fixture corpus. */
import { classify, distinctnessKey } from './classify.ts';
import { rpcCall, rpcUrl } from './rpc.ts';
import {
  readManifest,
  writeManifest,
  writeTransactionFixture,
  type FixtureEntry,
} from './manifest.ts';

const GET_TRANSACTION_CONFIG = {
  encoding: 'json',
  maxSupportedTransactionVersion: 0,
  commitment: 'confirmed',
} as const;

interface RawResult {
  meta: { err: unknown; logMessages: readonly string[] | null } | null;
}

/** Derive the expectations the corpus test will assert, from the wire JSON. */
export function expectationsFor(
  err: unknown,
): Pick<FixtureEntry, 'failingInstructionIndex' | 'errorKind' | 'instructionErrorKind'> {
  const record = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
  const tuple = record?.['InstructionError'];

  if (Array.isArray(tuple) && tuple.length === 2 && typeof tuple[0] === 'number') {
    const inner = tuple[1] as unknown;
    let instructionErrorKind = 'unrecognized';
    if (typeof inner === 'string') {
      instructionErrorKind = 'named';
    } else if (typeof inner === 'object' && inner !== null) {
      const key = Object.keys(inner)[0];
      if (key === 'Custom') instructionErrorKind = 'custom';
      else if (key === 'BorshIoError') instructionErrorKind = 'borsh-io-error';
    }
    return {
      failingInstructionIndex: tuple[0],
      errorKind: 'instruction-error',
      instructionErrorKind,
    };
  }

  if (typeof err === 'string') {
    return { failingInstructionIndex: null, errorKind: 'simple', instructionErrorKind: null };
  }

  const key = record === null ? undefined : Object.keys(record)[0];
  const errorKind =
    key === 'InsufficientFundsForRent'
      ? 'insufficient-funds-for-rent'
      : key === 'ProgramExecutionTemporarilyRestricted'
        ? 'program-execution-temporarily-restricted'
        : key === 'DuplicateInstruction'
          ? 'duplicate-instruction'
          : 'unrecognized';

  return { failingInstructionIndex: null, errorKind, instructionErrorKind: null };
}

export async function record(signature: string, note: string): Promise<FixtureEntry> {
  const url = rpcUrl();
  const result = await rpcCall<RawResult | null>(url, 'getTransaction', [
    signature,
    GET_TRANSACTION_CONFIG,
  ]);

  if (result === null) {
    throw new Error(
      `${signature} returned null. Either it never landed or it is outside this endpoint's ` +
        'retention window — an archive endpoint is needed to tell those apart.',
    );
  }
  if (result.meta === null) {
    throw new Error(`${signature} has no meta, so there is nothing to assert against.`);
  }
  if (result.meta.err === null) {
    throw new Error(`${signature} succeeded. The corpus records failures only.`);
  }

  const logs = result.meta.logMessages ?? [];
  const category = classify({ err: result.meta.err, logs });
  if (category === null) {
    throw new Error(
      `${signature} did not match any corpus category. Add a rule to scripts/lib/classify.ts ` +
        'or record it by hand.',
    );
  }

  const file = await writeTransactionFixture(signature, result);
  const entry: FixtureEntry = {
    signature,
    category,
    file,
    ...expectationsFor(result.meta.err),
    expectTruncatedLogs: logs.includes('Log truncated'),
    distinctnessKey: distinctnessKey({ err: result.meta.err, logs }),
    note,
  };

  const manifest = await readManifest();
  const entries = manifest.entries.filter((existing) => existing.signature !== signature);
  entries.push(entry);
  await writeManifest({ entries });

  return entry;
}
