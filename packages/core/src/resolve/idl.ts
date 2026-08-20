import { address as toAddress, createAddressWithSeed, getProgramDerivedAddress } from '@solana/kit';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { AccountSource } from '../rpc/source.ts';

/**
 * The seed Anchor derives its IDL account from.
 *
 * The address is `createWithSeed(findProgramAddress([], programId), "anchor:idl",
 * programId)`. Because the derivation is fixed, an account existing there is
 * itself evidence: only an Anchor program publishes one, which is the fact the
 * built-in error table is allowed to rest on.
 */
const IDL_SEED = 'anchor:idl';

/** 8-byte account discriminator, 32-byte authority, then a u32 length prefix. */
const IDL_HEADER_SIZE = 44;

export interface IdlErrorEntry {
  name: string;
  /** The `#[msg]` text, absent when the program declared the variant without one. */
  msg: string | null;
}

/** One component of an IDL-declared PDA derivation. */
export interface IdlSeed {
  kind: 'const' | 'account' | 'arg';
  /** Literal bytes, for a `const` component. */
  value: number[] | null;
  /**
   * The path the component reads, for `arg` and `account`.
   *
   * A bare name (`mint`) refers to an account passed to the instruction or to a
   * declared argument. A dotted name (`pool.base_mint`) reads a field out of
   * another account's data, which the transaction record does not contain.
   */
  path: string | null;
}

/** One account position an instruction declares. */
export interface IdlAccountSpec {
  name: string;
  /** Declared seeds, when the IDL constrains this account to a PDA. */
  seeds: IdlSeed[] | null;
  /**
   * The program the address derives under, when it is not the declaring program.
   *
   * Present on 155 of the 571 seeded accounts in the corpus — an associated
   * token account derives under the Associated Token program, not under the
   * program that declares it. Deriving everything under the declaring program
   * turns each of those into a spurious mismatch, which is a confidently wrong
   * answer about an account that was perfectly correct.
   */
  program: IdlSeed | null;
  /**
   * Whether the caller may omit this account.
   *
   * Load-bearing for positional naming: an omitted optional account shifts every
   * account after it, and the IDL does not record which ones a given call
   * supplied. Names therefore stop at the first optional account rather than
   * risk labelling the rest wrongly.
   */
  optional: boolean;
}

/** One declared instruction argument. Its type is kept verbatim for decoding. */
export interface IdlArg {
  name: string;
  type: unknown;
}

export interface IdlHandler {
  name: string;
  /** The 8 bytes that select this handler, hex-encoded for comparison and display. */
  discriminator: string;
  /**
   * Accounts in the order the instruction takes them, with composite groups
   * flattened.
   *
   * Order is the whole point: instruction accounts are positional, while the IDL
   * may nest them under named groups. Flattening in declaration order is what
   * lets position N in the transaction be matched to a name.
   */
  accounts: IdlAccountSpec[];
  args: IdlArg[];
}

export interface ResolvedIdl {
  address: string;
  programName: string;
  /**
   * `metadata.spec` for Anchor 0.30 and later; `null` for the earlier layout.
   *
   * Both are live on mainnet in roughly equal numbers, and they differ in ways
   * that matter: the older one names instructions in camelCase and omits
   * discriminators entirely.
   */
  spec: string | null;
  errors: Map<number, IdlErrorEntry>;
  handlers: IdlHandler[];
}

export type IdlOutcome =
  | { kind: 'found'; idl: ResolvedIdl }
  /** No account at the derived address. Nothing proves this program is Anchor. */
  | { kind: 'absent'; address: string }
  /** An account exists but could not be read as an IDL. */
  | { kind: 'unreadable'; address: string; reason: string };

/** The address Anchor publishes a program's IDL at. */
export async function idlAddressFor(programId: string): Promise<string> {
  const programAddress = toAddress(programId);
  const [base] = await getProgramDerivedAddress({ programAddress, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress, seed: IDL_SEED });
}

/**
 * Anchor's instruction discriminator: the first 8 bytes of
 * `sha256("global:" + snake_case_name)`.
 *
 * Only needed for the pre-0.30 layout, which stores no discriminators and names
 * its instructions in camelCase. Newer IDLs ship the bytes explicitly and are
 * read rather than recomputed — deriving them anyway would silently paper over a
 * program whose IDL and binary disagree.
 */
export function deriveDiscriminator(instructionName: string): string {
  const snake = instructionName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return createHash('sha256').update(`global:${snake}`).digest('hex').slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseErrors(raw: unknown): Map<number, IdlErrorEntry> {
  const errors = new Map<number, IdlErrorEntry>();
  if (!Array.isArray(raw)) return errors;

  for (const entry of raw as unknown[]) {
    const record = asRecord(entry);
    if (record === null) continue;
    const code = record['code'];
    const name = asString(record['name']);
    if (typeof code !== 'number' || name === null) continue;
    errors.set(code, { name, msg: asString(record['msg']) });
  }

  return errors;
}

function parseSeed(raw: unknown): IdlSeed | null {
  const record = asRecord(raw);
  const kind = asString(record?.['kind']);
  if (kind !== 'const' && kind !== 'account' && kind !== 'arg') return null;

  const value = record?.['value'];
  return {
    kind,
    value: Array.isArray(value) ? (value as number[]) : null,
    path: asString(record?.['path']),
  };
}

/** The `pda` block: the seed list, and the program to derive under when it differs. */
function parsePda(raw: unknown): { seeds: IdlSeed[] | null; program: IdlSeed | null } {
  const pda = asRecord(raw);
  const declared = pda?.['seeds'];
  if (!Array.isArray(declared)) return { seeds: null, program: null };

  const seeds: IdlSeed[] = [];
  for (const entry of declared as unknown[]) {
    const seed = parseSeed(entry);
    // One component this reader cannot represent makes the whole derivation
    // unusable, so the seed list is dropped rather than silently shortened.
    if (seed === null) return { seeds: null, program: null };
    seeds.push(seed);
  }

  return { seeds, program: pda?.['program'] === undefined ? null : parseSeed(pda['program']) };
}

/**
 * Flatten an instruction's declared accounts into positional order.
 *
 * Anchor lets an accounts struct compose others, and the IDL mirrors that by
 * nesting a group under its own `accounts` array. The runtime sees one flat list,
 * so the nesting has to be walked in declaration order or every name after the
 * first group lands on the wrong account.
 */
function parseAccounts(raw: unknown, into: IdlAccountSpec[] = []): IdlAccountSpec[] {
  if (!Array.isArray(raw)) return into;

  for (const entry of raw as unknown[]) {
    const record = asRecord(entry);
    if (record === null) continue;

    if (Array.isArray(record['accounts'])) {
      parseAccounts(record['accounts'], into);
      continue;
    }

    const name = asString(record['name']);
    if (name === null) continue;
    // `optional` is the 0.30+ spelling, `isOptional` the earlier one.
    const optional = record['optional'] === true || record['isOptional'] === true;
    const pda = parsePda(record['pda']);
    into.push({ name, seeds: pda.seeds, program: pda.program, optional });
  }

  return into;
}

function parseArgs(raw: unknown): IdlArg[] {
  if (!Array.isArray(raw)) return [];

  const args: IdlArg[] = [];
  for (const entry of raw as unknown[]) {
    const record = asRecord(entry);
    const name = asString(record?.['name']);
    if (name === null || record === null) continue;
    args.push({ name, type: record['type'] });
  }

  return args;
}

function parseHandlers(raw: unknown): IdlHandler[] {
  if (!Array.isArray(raw)) return [];

  const handlers: IdlHandler[] = [];
  for (const entry of raw as unknown[]) {
    const record = asRecord(entry);
    const name = asString(record?.['name']);
    if (name === null) continue;

    const declared = record?.['discriminator'];
    const discriminator = Array.isArray(declared)
      ? Buffer.from(declared as number[]).toString('hex')
      : deriveDiscriminator(name);

    handlers.push({
      name,
      discriminator,
      accounts: parseAccounts(record?.['accounts']),
      args: parseArgs(record?.['args']),
    });
  }

  return handlers;
}

/**
 * Read an inflated IDL document into one shape, whichever layout it uses.
 *
 * The two differ in where the program name lives (`metadata.name` versus a
 * top-level `name`) and in whether instructions carry discriminators. `errors[]`
 * is `{ code, name, msg }` in both, which is the part this tier most needs.
 */
export function parseIdlDocument(document: unknown, address: string): ResolvedIdl | null {
  const root = asRecord(document);
  if (root === null) return null;

  const metadata = asRecord(root['metadata']);
  const programName = asString(metadata?.['name']) ?? asString(root['name']);
  if (programName === null) return null;

  return {
    address,
    programName,
    spec: asString(metadata?.['spec']),
    errors: parseErrors(root['errors']),
    handlers: parseHandlers(root['instructions']),
  };
}

/**
 * Decode an IDL account's raw bytes.
 *
 * Layout: an 8-byte account discriminator, a 32-byte authority, a u32 little-endian
 * byte length, and then that many bytes of zlib-compressed JSON. The trailing
 * capacity beyond the declared length is slack Anchor leaves for a larger IDL to
 * be written later, and inflating past it fails.
 */
export function decodeIdlAccount(bytes: Uint8Array, address: string): ResolvedIdl | null {
  if (bytes.length < IDL_HEADER_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(40, true);
  if (length === 0 || IDL_HEADER_SIZE + length > bytes.length) return null;

  const json = inflateSync(bytes.subarray(IDL_HEADER_SIZE, IDL_HEADER_SIZE + length)).toString(
    'utf8',
  );
  return parseIdlDocument(JSON.parse(json) as unknown, address);
}

/**
 * Fetch and decode a program's on-chain IDL.
 *
 * `absent` is a first-class outcome rather than an error: most programs publish
 * no IDL, and the tier's behaviour in that case — decline to name the error code
 * at all — is a deliberate answer, not a failure.
 */
export async function resolveIdl(programId: string, source: AccountSource): Promise<IdlOutcome> {
  const address = await idlAddressFor(programId);
  const account = await source.fetchAccount(address);

  if (account === null) return { kind: 'absent', address };

  try {
    const bytes = Uint8Array.from(Buffer.from(account.data, 'base64'));
    const idl = decodeIdlAccount(bytes, address);
    if (idl === null) {
      return { kind: 'unreadable', address, reason: 'The account does not hold an Anchor IDL.' };
    }
    return { kind: 'found', idl };
  } catch (error) {
    return {
      kind: 'unreadable',
      address,
      reason: `The IDL account could not be decompressed or parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Handlers whose discriminator matches the first 8 bytes of some instruction data. */
export function handlerForDiscriminator(idl: ResolvedIdl, data: Uint8Array): IdlHandler | null {
  if (data.length < 8) return null;
  const prefix = Buffer.from(data.subarray(0, 8)).toString('hex');
  return idl.handlers.find((handler) => handler.discriminator === prefix) ?? null;
}
