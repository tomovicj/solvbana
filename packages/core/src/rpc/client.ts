import { createSolanaRpc, signature as toSignature, type Signature } from '@solana/kit';
import type { RawTransaction } from '../ingest/types.ts';
import type { Endpoint, FetchOutcome, NotFoundReason, TransactionSource } from './source.ts';

export interface TransactionSourceConfig {
  rpcUrl: string;
  /**
   * Optional archive endpoint. Without one, a signature older than the primary
   * node's retention (~2 days on public nodes) cannot be distinguished from one
   * that never landed.
   */
  archiveRpcUrl?: string | undefined;
}

type Rpc = ReturnType<typeof createSolanaRpc>;

/**
 * `getTransaction` config used for every request.
 *
 * `maxSupportedTransactionVersion: 0` is mandatory, not a preference — omitting
 * it makes the server error on every v0 transaction rather than returning one.
 *
 * `encoding: 'json'` rather than `'jsonParsed'` because the instruction tree is
 * built from raw `programIdIndex` / `accounts` indices; `jsonParsed` substitutes
 * addresses and best-effort parses, discarding the indexing the later tiers need.
 */
const GET_TRANSACTION_CONFIG = {
  encoding: 'json',
  maxSupportedTransactionVersion: 0,
} as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getTransaction(rpc: Rpc, signature: Signature): Promise<RawTransaction | null> {
  const response = await rpc.getTransaction(signature, GET_TRANSACTION_CONFIG).send();
  return response as RawTransaction | null;
}

/**
 * Whether the ledger knows this signature at all.
 *
 * `searchTransactionHistory` makes the node look past its recent-status cache
 * into block storage, which is what separates "we have no record" from "the
 * record exists but this endpoint is not serving it".
 */
async function signatureLanded(rpc: Rpc, signature: Signature): Promise<boolean> {
  const statuses = await rpc
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .send();
  return statuses.value[0] != null;
}

async function firstAvailableSlot(rpc: Rpc): Promise<bigint | null> {
  try {
    return await rpc.getFirstAvailableBlock().send();
  } catch {
    // Only used to quote a retention boundary in an explanation; its absence
    // must not turn a resolvable not-found into an error.
    return null;
  }
}

/**
 * Build a source over a primary endpoint and an optional archive.
 *
 * The whole point of this layer is to never collapse a `null` response into a
 * bare "not found". A `null` means either "never landed" or "outside the
 * retention window", and those are different facts about the world. Which one is
 * reported depends strictly on what was actually searched — the escalation never
 * claims to have ruled out more than it looked at.
 */
export function createTransactionSource(config: TransactionSourceConfig): TransactionSource {
  const primary = createSolanaRpc(config.rpcUrl);
  const archive = config.archiveRpcUrl === undefined ? null : createSolanaRpc(config.archiveRpcUrl);

  async function attempt(
    rpc: Rpc,
    endpoint: Endpoint,
    signature: Signature,
  ): Promise<{ raw: RawTransaction } | { error: string } | null> {
    try {
      const raw = await getTransaction(rpc, signature);
      return raw === null ? null : { raw };
    } catch (error) {
      return { error: `${endpoint} RPC failed: ${messageOf(error)}` };
    }
  }

  async function resolveNotFound(rpc: Rpc, signature: Signature): Promise<NotFoundReason> {
    let landed = false;
    try {
      landed = await signatureLanded(rpc, signature);
    } catch {
      // A failed status lookup tells us nothing new; fall through to the
      // conclusion the endpoints we did search support.
    }

    if (landed) return { kind: 'landed-but-unavailable' };

    if (archive !== null) return { kind: 'never-landed', basis: 'archive-searched' };

    // Without a configured archive, one thing can still rule out the retention
    // window: an endpoint whose oldest block is genesis serves the whole ledger,
    // so nothing was out of its reach and the record genuinely does not exist.
    const oldest = await firstAvailableSlot(rpc);
    if (oldest === 0n) {
      return { kind: 'never-landed', basis: 'primary-serves-full-history' };
    }

    // Otherwise the search cannot see past the retention window, and claiming the
    // transaction never landed would assert more than the evidence supports.
    return { kind: 'outside-searched-window', firstAvailableSlot: oldest };
  }

  return {
    async fetchTransaction(rawSignature: string): Promise<FetchOutcome> {
      const signature = toSignature(rawSignature);

      const fromPrimary = await attempt(primary, 'primary', signature);
      if (fromPrimary !== null && 'raw' in fromPrimary) {
        return { kind: 'found', raw: fromPrimary.raw, endpoint: 'primary' };
      }
      if (fromPrimary !== null) {
        return { kind: 'rpc-error', endpoint: 'primary', message: fromPrimary.error };
      }

      if (archive !== null) {
        const fromArchive = await attempt(archive, 'archive', signature);
        if (fromArchive !== null && 'raw' in fromArchive) {
          return { kind: 'found', raw: fromArchive.raw, endpoint: 'archive' };
        }
        if (fromArchive !== null) {
          return { kind: 'rpc-error', endpoint: 'archive', message: fromArchive.error };
        }
      }

      return {
        kind: 'not-found',
        reason: await resolveNotFound(archive ?? primary, signature),
        searchedArchive: archive !== null,
      };
    },
  };
}

/**
 * Explain a not-found outcome in terms of what was searched.
 *
 * Kept next to the escalation that produces the reason so the wording cannot
 * drift from the evidence behind it.
 */
export function explainNotFound(reason: NotFoundReason): string {
  switch (reason.kind) {
    case 'never-landed': {
      const searched =
        reason.basis === 'archive-searched'
          ? 'No record of this signature in either the primary or the archive endpoint.'
          : 'No record of this signature in the primary endpoint, which reports its oldest ' +
            'available block as genesis and therefore serves the full ledger.';
      return (
        `${searched} The transaction was never recorded on chain: it was rejected at preflight, ` +
        'dropped by the leader, or expired on a stale blockhash. Only landed transactions can be ' +
        'retrieved from a signature.'
      );
    }
    case 'outside-searched-window': {
      const boundary =
        reason.firstAvailableSlot === null
          ? ''
          : ` The primary node's oldest available block is slot ${String(reason.firstAvailableSlot)}.`;
      return (
        "Not found within the primary endpoint's retention window, which is roughly two days on " +
        'public nodes. No archive endpoint is configured, so this cannot be distinguished from a ' +
        'transaction that never landed. Configure SOLANA_ARCHIVE_RPC_URL to tell the two apart.' +
        boundary
      );
    }
    case 'landed-but-unavailable':
      return (
        'The ledger reports this signature as landed, but no endpoint returned its transaction ' +
        'record. The data exists; the endpoints searched are not serving it.'
      );
  }
}
