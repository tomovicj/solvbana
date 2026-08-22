import type { ArtifactStore } from '../rpc/source.ts';
import { parseIdlDocument, type ResolvedIdl } from './idl.ts';

export type SuppliedIdlOutcome =
  | { kind: 'found'; idl: ResolvedIdl }
  /** Nothing has been uploaded for this program. */
  | { kind: 'absent' }
  /** Something was uploaded but could not be read as an IDL. */
  | { kind: 'unreadable' }
  /**
   * A document exists but does not describe the instruction that ran.
   *
   * The strongest check available on an uploaded file, and the reason one may be
   * trusted at all: none of its declared handlers carries the discriminator the
   * failing instruction actually used. An 8-byte match is not a coincidence, and
   * its absence means this document is for a different program or a different
   * version of one.
   */
  | { kind: 'unproven'; programName: string };

/**
 * Fetch an uploaded IDL and make it prove it belongs to this program.
 *
 * The proof is the discriminator, computed from the transaction and costing
 * nothing. Without it the document is refused: an on-chain IDL is at least
 * evidence about chain state, while an uploaded one is evidence of nothing until
 * it matches something the program actually did.
 *
 * `observed` is the set of leading 8-byte prefixes, hex-encoded, from every
 * instruction in the transaction addressed to this program. An empty set cannot
 * prove anything, so it refuses rather than passing the document through.
 */
export async function suppliedIdl(
  store: ArtifactStore,
  programId: string,
  observed: readonly string[],
): Promise<SuppliedIdlOutcome> {
  const stored = await store.fetchIdl(programId);
  if (stored === null) return { kind: 'absent' };

  const idl = parseIdlDocument(stored.document, programId, 'supplied');
  if (idl === null) return { kind: 'unreadable' };

  const declared = new Set(idl.handlers.map((handler) => handler.discriminator));
  const proven = observed.some((discriminator) => declared.has(discriminator));

  return proven ? { kind: 'found', idl } : { kind: 'unproven', programName: idl.programName };
}

/** Why a supplied IDL was or was not used, in the same voice as the other notes. */
export function describeSuppliedIdl(outcome: SuppliedIdlOutcome, programId: string): string | null {
  switch (outcome.kind) {
    case 'absent':
      return null;
    case 'unreadable':
      return `An IDL is stored for ${programId} but could not be read as one, so it was not used.`;
    case 'unproven':
      return (
        `The IDL stored for ${programId} (${outcome.programName}) declares no handler matching ` +
        'the discriminator this transaction used, so it describes a different program or a ' +
        'different version of one. Nothing was read from it.'
      );
    case 'found':
      return (
        `Names for ${programId} come from an uploaded IDL (${outcome.idl.programName}), matched ` +
        'to this transaction by instruction discriminator. It is not evidence the program is ' +
        "Anchor the way an on-chain IDL is, so Anchor's built-in error table stays out of reach."
      );
  }
}
