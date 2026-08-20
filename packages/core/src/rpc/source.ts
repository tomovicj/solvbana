import type { RawTransaction } from '../ingest/types.ts';

export type Endpoint = 'primary' | 'archive';

/**
 * Why a signature did not resolve to a transaction.
 *
 * These are kept apart because they call for different actions from the reader.
 * "Never landed" means the transaction was rejected at preflight, dropped by the
 * leader, or expired on a stale blockhash — there is nothing to fetch, ever.
 * "Outside retention" means the record exists somewhere and an archive endpoint
 * would find it. Merging them into one "not found" would tell a user to go
 * looking for data that was never written, or to give up on data that is there.
 */
/** How a `never-landed` conclusion was reached — the evidence that rules out retention. */
export type NeverLandedBasis =
  /** An archive endpoint was configured and searched, and it had nothing either. */
  | 'archive-searched'
  /** The primary reported its oldest block as genesis, so it serves the full ledger. */
  | 'primary-serves-full-history';

export type NotFoundReason =
  /** Every endpoint that could hold the record was searched. It does not exist. */
  | { kind: 'never-landed'; basis: NeverLandedBasis }
  /** Only the primary node was searched, and its retention window is short (~2 days). */
  | { kind: 'outside-searched-window'; firstAvailableSlot: bigint | null }
  /**
   * `getSignatureStatuses` found the signature but `getTransaction` returned
   * nothing — the transaction landed, yet its record is not being served.
   */
  | { kind: 'landed-but-unavailable' };

export type FetchOutcome =
  | { kind: 'found'; raw: RawTransaction; endpoint: Endpoint }
  | { kind: 'not-found'; reason: NotFoundReason; searchedArchive: boolean }
  | { kind: 'rpc-error'; endpoint: Endpoint; message: string };

/**
 * The port `diagnose()` fetches through.
 *
 * Defined as an interface so tests can drive the engine from a recorded fixture
 * instead of the network. The fixture corpus is the regression suite for every
 * phase, and it is only trustworthy if it runs offline and deterministically.
 */
export interface TransactionSource {
  fetchTransaction(signature: string): Promise<FetchOutcome>;
}

/**
 * One account read, with the slot it was served at.
 *
 * `readAtSlot` is not decoration. Source resolution turns on whether a program
 * was upgraded between the failing transaction's slot and now, and "now" has to
 * be a recorded number for that question to have a stable answer — otherwise a
 * fixture that resolves today quietly reports something else next month.
 */
export interface AccountSnapshot {
  address: string;
  owner: string;
  executable: boolean;
  /** Base64, exactly as the RPC returned it. */
  data: string;
  /** Total size of the account on chain, which a prefix read does not tell you. */
  size: number;
  readAtSlot: bigint;
}

/**
 * The port source resolution reads accounts through.
 *
 * A second port beside {@link TransactionSource} rather than an extension of it:
 * the two have different lifetimes in a diagnosis (one transaction, many
 * programs) and different cacheability, and keeping them apart lets a test
 * supply recorded accounts without also having to supply a transaction.
 */
export interface AccountSource {
  fetchAccount(address: string): Promise<AccountSnapshot | null>;
  /**
   * Read only the first `length` bytes.
   *
   * Worth having as its own method: a ProgramData account is padded to megabytes
   * of zeros, and the deployment slot this layer needs lives in the first 45
   * bytes of it.
   */
  fetchAccountPrefix(address: string, length: number): Promise<AccountSnapshot | null>;
}
