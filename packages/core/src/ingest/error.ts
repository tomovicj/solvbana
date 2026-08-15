import type { InstructionError, TransactionError } from './types.ts';

/**
 * Narrow an unknown value to a plain object without asserting its fields.
 *
 * `meta.err` is parsed from `unknown` rather than from the RPC library's typed
 * union on purpose. The library's type is incomplete against the wire format —
 * it declares `BorshIoError` as a bare string when the runtime actually emits
 * `{"BorshIoError": "..."}` — and new runtime variants ship independently of it.
 * Trusting the declared type would turn a diagnosable transaction into a crash.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read the sole key of a single-entry object, which is how Rust enums serialize. */
function singleVariant(value: unknown): { name: string; payload: unknown } | null {
  const record = asRecord(value);
  if (record === null) return null;

  const entries = Object.entries(record);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) return null;

  return { name: entry[0], payload: entry[1] };
}

/**
 * Read an integer that may arrive as either a `number` or a `bigint`.
 *
 * `@solana/kit` upcasts the integers inside `meta.err` to `bigint` while leaving
 * structural indices elsewhere as `number`, so a `typeof x === 'number'` check
 * silently rejects every real error and reports it as unrecognized. Every
 * numeric read out of `meta.err` has to accept both.
 */
function toInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function accountIndexOf(payload: unknown): number | null {
  return toInteger(asRecord(payload)?.['account_index']);
}

/** `JSON.stringify` throws on `bigint`, and unparsed error payloads contain them. */
function renderRaw(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

/**
 * Parse the second element of an `InstructionError` tuple.
 *
 * The runtime emits either a bare string variant (`"MissingRequiredSignature"`)
 * or a single-key object carrying a payload (`{"Custom": 6001}`).
 */
export function parseInstructionError(raw: unknown): InstructionError {
  if (typeof raw === 'string') {
    return { kind: 'named', name: raw };
  }

  const variant = singleVariant(raw);
  if (variant === null) {
    return { kind: 'unrecognized', raw };
  }

  const code = variant.name === 'Custom' ? toInteger(variant.payload) : null;
  if (code !== null) {
    return { kind: 'custom', code };
  }

  if (variant.name === 'BorshIoError' && typeof variant.payload === 'string') {
    return { kind: 'borsh-io-error', message: variant.payload };
  }

  // A known-shaped variant carrying a payload this parser has no case for. The
  // name is still useful, so keep it rather than falling all the way through.
  return { kind: 'unrecognized', raw };
}

/**
 * Parse `meta.err` into a typed union.
 *
 * Every arm that fails to match retains the original value under `raw`. A
 * variant this parser has never seen still has to reach the output, because
 * "instruction 2 failed with something we cannot name" is a usable answer and a
 * thrown exception is not.
 */
export function parseTransactionError(raw: unknown): TransactionError {
  if (typeof raw === 'string') {
    return { kind: 'simple', name: raw };
  }

  const variant = singleVariant(raw);
  if (variant === null) {
    return { kind: 'unrecognized', raw };
  }

  switch (variant.name) {
    case 'InstructionError': {
      const payload = variant.payload;
      if (!Array.isArray(payload) || payload.length !== 2) break;

      const [rawIndex, inner] = payload as [unknown, unknown];
      const index = toInteger(rawIndex);
      if (index === null) break;

      return { kind: 'instruction-error', index, error: parseInstructionError(inner) };
    }

    case 'InsufficientFundsForRent': {
      const accountIndex = accountIndexOf(variant.payload);
      if (accountIndex === null) break;
      return { kind: 'insufficient-funds-for-rent', accountIndex };
    }

    case 'ProgramExecutionTemporarilyRestricted': {
      const accountIndex = accountIndexOf(variant.payload);
      if (accountIndex === null) break;
      return { kind: 'program-execution-temporarily-restricted', accountIndex };
    }

    case 'DuplicateInstruction': {
      const index = toInteger(variant.payload);
      if (index === null) break;
      return { kind: 'duplicate-instruction', index };
    }
  }

  return { kind: 'unrecognized', raw };
}

/**
 * The index of the instruction that failed, or `null` for a transaction-level
 * failure that no single instruction is responsible for.
 */
export function failingInstructionIndex(error: TransactionError): number | null {
  return error.kind === 'instruction-error' ? error.index : null;
}

/** A short human-readable rendering, used in the diagnosis summary line. */
export function describeTransactionError(error: TransactionError): string {
  switch (error.kind) {
    case 'instruction-error':
      return describeInstructionError(error.error);
    case 'insufficient-funds-for-rent':
      return `InsufficientFundsForRent (account index ${String(error.accountIndex)})`;
    case 'program-execution-temporarily-restricted':
      return `ProgramExecutionTemporarilyRestricted (account index ${String(error.accountIndex)})`;
    case 'duplicate-instruction':
      return `DuplicateInstruction (instruction ${String(error.index)})`;
    case 'simple':
      return error.name;
    case 'unrecognized':
      return `an unrecognized error variant (${renderRaw(error.raw)})`;
  }
}

export function describeInstructionError(error: InstructionError): string {
  switch (error.kind) {
    case 'custom':
      return `Custom(${String(error.code)})`;
    case 'named':
      return error.name;
    case 'borsh-io-error':
      return `BorshIoError(${error.message})`;
    case 'unrecognized':
      return `an unrecognized instruction error (${renderRaw(error.raw)})`;
  }
}
