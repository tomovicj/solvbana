import { getBase58Decoder } from '@solana/kit';
import type { IdlArg } from '../resolve/idl.ts';
import type { DecodedArg } from './types.ts';

/**
 * Render an IDL type expression as the text a developer would recognise.
 *
 * The two IDL layouts spell types differently — a plain string for primitives,
 * a single-key object for containers — so this normalizes both into the Rust
 * spelling rather than leaking the JSON shape into the output.
 */
export function describeType(type: unknown): string {
  if (typeof type === 'string') return type;
  if (typeof type !== 'object' || type === null) return 'unknown';

  const record = type as Record<string, unknown>;
  if ('vec' in record) return `Vec<${describeType(record['vec'])}>`;
  if ('option' in record) return `Option<${describeType(record['option'])}>`;
  if ('array' in record && Array.isArray(record['array'])) {
    const [inner, length] = record['array'] as [unknown, unknown];
    return `[${describeType(inner)}; ${String(length)}]`;
  }
  if ('defined' in record) {
    const defined = record['defined'];
    const name =
      typeof defined === 'string'
        ? defined
        : ((defined as Record<string, unknown>)?.['name'] ?? '');
    return typeof name === 'string' && name.length > 0 ? name : 'defined';
  }
  return 'unknown';
}

/** Byte width of a fixed-size integer type, or `null` when it is not one. */
function intWidth(type: string): number | null {
  const match = /^[ui](8|16|32|64|128)$/.exec(type);
  return match === null ? null : Number(match[1]) / 8;
}

/**
 * A cursor over borsh-encoded instruction data.
 *
 * Reads are bounds-checked and a short read stops decoding rather than throwing:
 * an IDL that has drifted from the deployed binary will describe arguments the
 * data does not contain, and that is a disagreement to report, not a crash.
 */
class Reader {
  private offset: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.offset = 0;
  }

  take(length: number): Uint8Array | null {
    if (length < 0 || this.offset + length > this.bytes.length) return null;
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

/** Reads a little-endian integer, returning the bytes as well — Anchor seeds them verbatim. */
function readInteger(
  reader: Reader,
  type: string,
  width: number,
): { value: bigint; bytes: Uint8Array } | null {
  const bytes = reader.take(width);
  if (bytes === null) return null;

  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);

  if (!type.startsWith('u')) {
    // Two's complement for the signed widths.
    const bits = BigInt(width * 8);
    if (value >= 1n << (bits - 1n)) value -= 1n << bits;
  }

  return { value, bytes: Uint8Array.from(bytes) };
}

/**
 * Decode one value, returning both its rendered text and the bytes Anchor would
 * use for it as a PDA seed.
 *
 * The seed bytes are not the borsh encoding. Anchor's `seeds = [...]` writes an
 * explicit conversion in source — `to_le_bytes()` for an integer, `as_bytes()`
 * for a string, `as_ref()` for a pubkey — and the IDL records only which
 * argument was used. These are those conversions, which is why a `String` seed
 * carries no length prefix while its borsh encoding does.
 */
function readValue(
  reader: Reader,
  type: unknown,
): { text: string; seed: Uint8Array | null } | null {
  const name = describeType(type);

  if (name === 'bool') {
    const bytes = reader.take(1);
    return bytes === null ? null : { text: bytes[0] === 1 ? 'true' : 'false', seed: bytes };
  }

  const width = intWidth(name);
  if (width !== null) {
    const read = readInteger(reader, name, width);
    // Anchor seeds an integer with `to_le_bytes()`, which is exactly the
    // encoding already on the wire, so the same bytes serve both purposes.
    return read === null ? null : { text: read.value.toString(), seed: read.bytes };
  }

  if (name === 'pubkey' || name === 'publicKey') {
    const bytes = reader.take(32);
    return bytes === null
      ? null
      : { text: getBase58Decoder().decode(bytes), seed: Uint8Array.from(bytes) };
  }

  if (name === 'string') {
    const length = readInteger(reader, 'u32', 4);
    if (length === null) return null;
    const bytes = reader.take(Number(length.value));
    if (bytes === null) return null;
    return { text: new TextDecoder().decode(bytes), seed: Uint8Array.from(bytes) };
  }

  if (name === 'bytes') {
    const length = readInteger(reader, 'u32', 4);
    if (length === null) return null;
    const bytes = reader.take(Number(length.value));
    return bytes === null ? null : { text: toHex(bytes), seed: Uint8Array.from(bytes) };
  }

  return null;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Decode an instruction's arguments against the types its IDL declares.
 *
 * Composite types (structs and enums the IDL defines under `types[]`) are not
 * decoded. Their layout is available, but a partially decoded argument list is
 * worse than an honestly incomplete one: every argument after an
 * incorrectly-sized one would be garbage that still looks like a number.
 * Decoding therefore stops at the first unsupported type and says so.
 */
export function decodeArgs(
  data: Uint8Array,
  args: readonly IdlArg[],
): { decoded: DecodedArg[]; seeds: Map<string, Uint8Array> } {
  const decoded: DecodedArg[] = [];
  const seeds = new Map<string, Uint8Array>();
  // The leading 8 bytes are the handler discriminator, not an argument.
  const reader = new Reader(data.subarray(8));
  let stopped = false;

  for (const arg of args) {
    const type = describeType(arg.type);
    if (stopped) {
      decoded.push({ name: arg.name, type, value: null });
      continue;
    }

    const value = readValue(reader, arg.type);
    if (value === null) {
      stopped = true;
      decoded.push({ name: arg.name, type, value: null });
      continue;
    }

    decoded.push({ name: arg.name, type, value: value.text });
    if (value.seed !== null) seeds.set(arg.name, value.seed);
  }

  return { decoded, seeds };
}
