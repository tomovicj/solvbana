import { getAddressDecoder } from '@solana/kit';
import type { AccountSnapshot, AccountSource } from '../rpc/source.ts';

/** The upgradeable loader. Programs it owns carry their bytes in a separate ProgramData account. */
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

/**
 * Loaders whose programs cannot change after deployment.
 *
 * This answers the slot question in the strongest possible way and for free: the
 * bytes running now are necessarily the bytes that ran then, with no ProgramData
 * account to read. The two pre-upgradeable BPF loaders finalize on deployment,
 * and a `NativeLoader` program is compiled into the validator itself.
 */
const IMMUTABLE_LOADERS = new Set([
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
]);

export const NATIVE_LOADER = 'NativeLoader1111111111111111111111111111111';

/** `UpgradeableLoaderState::Program` — the discriminant the program account carries. */
const STATE_PROGRAM = 2;
/** `UpgradeableLoaderState::ProgramData`. */
const STATE_PROGRAM_DATA = 3;

/**
 * Where the ELF starts inside a ProgramData account.
 *
 * 4 bytes of enum discriminant, 8 bytes of `slot`, then a 1-byte `Option` tag and
 * 32 bytes of upgrade authority. Confirmed against mainnet, and the offset the
 * verified-build hash is computed from.
 */
export const PROGRAM_DATA_HEADER_SIZE = 45;

export type Deployment =
  /**
   * The deployment live now is the one that ran: its `lastDeploySlot` is at or
   * before the failing transaction's slot. Read, not assumed.
   */
  | {
      kind: 'live';
      programData: string;
      lastDeploySlot: bigint;
      /** Size of the ProgramData account, padding included. */
      programDataSize: number;
      readAtSlot: bigint;
    }
  /** A non-upgradeable loader owns this program, so its bytes can never have changed. */
  | { kind: 'immutable'; loader: string }
  /** Redeployed after the transaction ran. The bytes that ran are no longer on chain. */
  | { kind: 'upgraded-since'; lastDeploySlot: bigint; failingSlot: bigint; programData: string }
  /** The ProgramData account no longer exists — the program was closed and its bytes reclaimed. */
  | { kind: 'closed'; programData: string }
  | { kind: 'unavailable'; reason: string };

function bytesOf(snapshot: AccountSnapshot): Uint8Array {
  return Uint8Array.from(Buffer.from(snapshot.data, 'base64'));
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

/** The ProgramData address a `Program` account points at, or `null` if it is not one. */
export function programDataAddressOf(bytes: Uint8Array): string | null {
  if (bytes.length < 36 || readU32LE(bytes, 0) !== STATE_PROGRAM) return null;
  return getAddressDecoder().decode(bytes.subarray(4, 36));
}

/** The deployment slot in a ProgramData header, or `null` if the account is not one. */
export function lastDeploySlotOf(bytes: Uint8Array): bigint | null {
  if (bytes.length < 12 || readU32LE(bytes, 0) !== STATE_PROGRAM_DATA) return null;
  return readU64LE(bytes, 4);
}

/**
 * Establish whether the binary on chain now is the binary that ran.
 *
 * This is the correctness gate the whole source-resolution tier hangs from, and
 * it reduces to one number. `UpgradeableLoaderState::ProgramData` stores the slot
 * of its most recent deployment in its header, so a 45-byte read answers it: if
 * that slot is at or before the failing transaction's, nothing has replaced the
 * bytes since, and the current deployment provably *is* the historical one.
 *
 * When it is not, the answer is a refusal rather than a fallback. `getAccountInfo`
 * only ever returns current state, so the bytes that ran are not retrievable at
 * any price from a standard RPC — walking the account's `Upgrade` transactions
 * would name the deployment without producing it. Reporting the current binary
 * anyway is the exact failure mode this project exists to avoid: it yields source
 * that looks right and describes different code.
 */
export async function resolveDeployment(
  programId: string,
  failingSlot: bigint,
  source: AccountSource,
): Promise<Deployment> {
  const program = await source.fetchAccount(programId);

  if (program === null) {
    return { kind: 'unavailable', reason: `No account exists at ${programId}.` };
  }

  if (IMMUTABLE_LOADERS.has(program.owner)) {
    return { kind: 'immutable', loader: program.owner };
  }

  if (program.owner !== BPF_LOADER_UPGRADEABLE) {
    return {
      kind: 'unavailable',
      reason:
        `${programId} is owned by ${program.owner}, which is not a loader this tool knows how ` +
        'to read. Its deployment history cannot be established.',
    };
  }

  const programData = programDataAddressOf(bytesOf(program));
  if (programData === null) {
    return {
      kind: 'unavailable',
      reason:
        `${programId} is owned by the upgradeable loader but its account does not hold a ` +
        'Program record pointing at a ProgramData account.',
    };
  }

  const header = await source.fetchAccountPrefix(programData, PROGRAM_DATA_HEADER_SIZE);
  if (header === null) {
    // The program account still points at it, but the data account is gone: the
    // program was closed and its bytes reclaimed for rent.
    return { kind: 'closed', programData };
  }

  const lastDeploySlot = lastDeploySlotOf(bytesOf(header));
  if (lastDeploySlot === null) {
    return {
      kind: 'unavailable',
      reason: `${programData} does not hold a ProgramData record.`,
    };
  }

  if (lastDeploySlot > failingSlot) {
    return { kind: 'upgraded-since', lastDeploySlot, failingSlot, programData };
  }

  return {
    kind: 'live',
    programData,
    lastDeploySlot,
    programDataSize: header.size,
    readAtSlot: header.readAtSlot,
  };
}

/** Whether this deployment is the one that ran, and therefore safe to resolve source against. */
export function isSlotAccurate(deployment: Deployment): boolean {
  return deployment.kind === 'live' || deployment.kind === 'immutable';
}

export function describeDeployment(deployment: Deployment): string {
  switch (deployment.kind) {
    case 'live':
      return (
        `The deployment live at slot ${String(deployment.readAtSlot)} was last upgraded at slot ` +
        `${String(deployment.lastDeploySlot)}, at or before this transaction, so the binary on ` +
        'chain now is the binary that ran.'
      );
    case 'immutable':
      return deployment.loader === NATIVE_LOADER
        ? 'The program is built into the validator rather than deployed on chain, so there is no ' +
            'binary to resolve and no version of it that could differ from the one that ran.'
        : `The program is owned by ${deployment.loader}, a non-upgradeable loader, so its bytes ` +
            'cannot have changed since it was deployed.';
    case 'upgraded-since':
      return (
        `The program was redeployed at slot ${String(deployment.lastDeploySlot)}, after this ` +
        `transaction ran at slot ${String(deployment.failingSlot)}. The binary that actually ran ` +
        'is no longer on chain, and a standard RPC serves only current account state, so it ' +
        'cannot be retrieved. No source is resolved against it rather than against the wrong one.'
      );
    case 'closed':
      return (
        `The program's data account ${deployment.programData} no longer exists: the program was ` +
        'closed and its bytes reclaimed. Nothing can be resolved about the code that ran.'
      );
    case 'unavailable':
      return deployment.reason;
  }
}
