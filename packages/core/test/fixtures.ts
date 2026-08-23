import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSnapshot, AccountSource, SourceTree } from '@solvbana/core';

export const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');

export function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), 'utf8')) as T;
}

interface RecordedAccount {
  owner: string;
  executable: boolean;
  data: string;
  size: number;
}

export interface ProgramSnapshotFixture {
  programId: string;
  readAtSlot: number;
  program: RecordedAccount | null;
  programDataHeader: (RecordedAccount & { address: string }) | null;
  idl: (RecordedAccount & { address: string }) | null;
  executableHash: string | null;
  trimmedElfLength: number | null;
}

/**
 * An account source backed by recorded program snapshots.
 *
 * Source resolution asks questions about live chain state — was this upgraded,
 * does it publish an IDL — and a live answer drifts underneath the corpus. The
 * snapshots pin both the answer and the slot it was read at, so the suite runs
 * offline and a fixture that resolves today still resolves the same way in a
 * year.
 *
 * Prefix reads are served by slicing the recorded bytes, which is exactly what
 * `dataSlice` does on the wire.
 */
export function snapshotAccounts(...snapshots: ProgramSnapshotFixture[]): AccountSource {
  const accounts = new Map<string, AccountSnapshot>();

  for (const snapshot of snapshots) {
    const readAtSlot = BigInt(snapshot.readAtSlot);

    if (snapshot.program !== null) {
      accounts.set(snapshot.programId, {
        address: snapshot.programId,
        ...snapshot.program,
        readAtSlot,
      });
    }
    for (const entry of [snapshot.programDataHeader, snapshot.idl]) {
      if (entry === null) continue;
      accounts.set(entry.address, { ...entry, readAtSlot });
    }
  }

  function slice(address: string, length: number | null): AccountSnapshot | null {
    const account = accounts.get(address);
    if (account === undefined) return null;
    if (length === null) return account;

    const bytes = Buffer.from(account.data, 'base64').subarray(0, length);
    return { ...account, data: bytes.toString('base64') };
  }

  return {
    fetchAccount: (address) => Promise.resolve(slice(address, null)),
    fetchAccountPrefix: (address, length) => Promise.resolve(slice(address, length)),
  };
}

/** Load one recorded program snapshot. */
export function programSnapshot(programId: string): ProgramSnapshotFixture {
  return readJson<ProgramSnapshotFixture>('programs', `${programId}.json`);
}

/** An account source over every recorded program in the corpus. */
export function corpusAccounts(programIds: readonly string[]): AccountSource {
  return snapshotAccounts(...programIds.map(programSnapshot));
}

/**
 * A synthetic Anchor source tree from `fixtures/source/<name>`.
 *
 * Hand-written rather than harvested, and kept apart from the transaction corpus
 * for the same reason `fixtures/synthetic/` is: no corpus program publishes its
 * source, so the throw-site index can only be scored against trees written for
 * the purpose. Paths are relative to the tree root and forward-slashed, which is
 * what an upload sends.
 */
export function sourceTree(name: string): SourceTree {
  const root = join(FIXTURES, 'source', name);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split('\\').join('/'))
    .filter((entry) => entry.endsWith('.rs'))
    .sort()
    .map((path) => ({ path, contents: readFileSync(join(root, path), 'utf8') }));

  return { files };
}
