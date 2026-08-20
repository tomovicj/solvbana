/**
 * Record the on-chain state source resolution reads, one file per program.
 *
 * Usage: `pnpm snapshot`
 *
 * Every question Phase 2 asks — was this binary upgraded since the transaction,
 * does the program publish an IDL, does its hash match a verified build — is a
 * question about live state, and a live answer changes underneath the corpus. A
 * program that resolves today is upgraded next month and the fixture that
 * asserted it quietly starts describing something else.
 *
 * So the answer is recorded together with the slot it was read at. "Upgraded
 * between the failing slot and the snapshot slot" is a fact about two fixed
 * numbers, and it stays true forever.
 *
 * The ProgramData *body* is deliberately not recorded. Whirlpool's is 10MB of
 * which 1.5MB is program and the rest is zero padding reserved for a future
 * upgrade; committing that per program would be absurd. The hash and the trimmed
 * length are recorded as facts instead, and the hashing code path is covered by a
 * small synthetic fixture.
 *
 * Manual only, never CI.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { idlAddressFor } from '@solvbana/core';
import { FIXTURES_DIR, MANIFEST_PATH } from './lib/manifest.ts';
import { rpcCall, rpcUrl, sleep } from './lib/rpc.ts';

const PROGRAMS_DIR = join(FIXTURES_DIR, 'programs');
const PROGRAM_DATA_HEADER_SIZE = 45;

interface AccountValue {
  owner: string;
  executable: boolean;
  data: [string, string];
  space: number;
}

interface AccountResponse {
  context: { slot: number };
  value: AccountValue | null;
}

interface RecordedAccount {
  owner: string;
  executable: boolean;
  /** Base64, as the RPC returned it. Truncated to a prefix where noted. */
  data: string;
  /** Full on-chain size, which a prefix read does not otherwise reveal. */
  size: number;
}

interface ProgramSnapshot {
  programId: string;
  /** The slot every read below was served at. */
  readAtSlot: number;
  program: RecordedAccount | null;
  /** The first 45 bytes only — the loader header carrying the deployment slot. */
  programDataHeader: (RecordedAccount & { address: string }) | null;
  idl: (RecordedAccount & { address: string }) | null;
  /** sha256 of the ELF with trailing zeros trimmed, recorded rather than the bytes. */
  executableHash: string | null;
  trimmedElfLength: number | null;
}

async function getAccount(
  url: string,
  addr: string,
  dataSlice?: { offset: number; length: number },
): Promise<AccountResponse> {
  return rpcCall<AccountResponse>(url, 'getAccountInfo', [
    addr,
    { encoding: 'base64', ...(dataSlice === undefined ? {} : { dataSlice }) },
  ]);
}

function recorded(value: AccountValue): RecordedAccount {
  return {
    owner: value.owner,
    executable: value.executable,
    data: value.data[0],
    size: value.space,
  };
}

/** The ProgramData address a `Program` account points at. */
function programDataAddress(base64: string): string | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 36 || bytes.readUInt32LE(0) !== 2) return null;
  // Base58-encode the 32-byte pubkey the same way the RPC would report it.
  return encodeBase58(bytes.subarray(4, 36));
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

async function hashExecutable(
  url: string,
  programData: string,
): Promise<{ hash: string; length: number } | null> {
  const response = await getAccount(url, programData);
  if (response.value === null) return null;

  const bytes = Buffer.from(response.value.data[0], 'base64');
  const elf = bytes.subarray(PROGRAM_DATA_HEADER_SIZE);
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end -= 1;

  return { hash: createHash('sha256').update(elf.subarray(0, end)).digest('hex'), length: end };
}

/**
 * How much of the program account to keep.
 *
 * A `Program` record is a 4-byte discriminant and a 32-byte address, and that is
 * all the resolver reads. The pre-upgradeable loaders keep the whole ELF in this
 * account instead, and recording that would put a megabyte of binary in the
 * corpus to answer a question the `owner` field already answers.
 */
const PROGRAM_ACCOUNT_PREFIX = 36;

async function snapshot(url: string, programId: string): Promise<ProgramSnapshot> {
  const program = await getAccount(url, programId, {
    offset: 0,
    length: PROGRAM_ACCOUNT_PREFIX,
  });
  const snap: ProgramSnapshot = {
    programId,
    readAtSlot: program.context.slot,
    program: program.value === null ? null : recorded(program.value),
    programDataHeader: null,
    idl: null,
    executableHash: null,
    trimmedElfLength: null,
  };

  if (
    program.value !== null &&
    program.value.owner === 'BPFLoaderUpgradeab1e11111111111111111111111'
  ) {
    const pd = programDataAddress(program.value.data[0]);
    if (pd !== null) {
      await sleep(250);
      const header = await getAccount(url, pd, { offset: 0, length: PROGRAM_DATA_HEADER_SIZE });
      snap.programDataHeader =
        header.value === null ? null : { address: pd, ...recorded(header.value) };

      if (header.value !== null) {
        await sleep(250);
        const hashed = await hashExecutable(url, pd);
        if (hashed !== null) {
          snap.executableHash = hashed.hash;
          snap.trimmedElfLength = hashed.length;
        }
      }
    }
  }

  // Reuses core's derivation rather than repeating it, so a script and the
  // engine can never disagree about where a program's IDL lives.
  const idlAddress = await idlAddressFor(programId);

  await sleep(250);
  const idl = await getAccount(url, idlAddress);
  snap.idl = idl.value === null ? null : { address: idlAddress, ...recorded(idl.value) };

  return snap;
}

const url = rpcUrl();
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
  entries: { phase1?: { program?: string | null } }[];
};

const programIds = [
  ...new Set(
    manifest.entries.flatMap((entry) => {
      const program = entry.phase1?.program;
      return typeof program === 'string' ? [program] : [];
    }),
  ),
].sort();

await mkdir(PROGRAMS_DIR, { recursive: true });

for (const programId of programIds) {
  try {
    const snap = await snapshot(url, programId);
    await writeFile(
      join(PROGRAMS_DIR, `${programId}.json`),
      `${JSON.stringify(snap, null, 2)}\n`,
      'utf8',
    );
    const deployed =
      snap.programDataHeader === null
        ? 'no-programdata'
        : String(Buffer.from(snap.programDataHeader.data, 'base64').readBigUInt64LE(4));
    console.log(
      `${programId.padEnd(45)} read@${String(snap.readAtSlot)} deploy@${deployed} ` +
        `idl:${snap.idl === null ? 'no' : 'yes'}`,
    );
  } catch (error) {
    console.error(`${programId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await sleep(400);
}

console.log(`\nSnapshotted ${String(programIds.length)} programs into fixtures/programs/.`);
