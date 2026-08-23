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

/**
 * The port supplied build artifacts are read through.
 *
 * A third port beside {@link TransactionSource} and {@link AccountSource},
 * because it answers a different kind of question: not "what does the chain
 * say" but "what has someone handed us about this program". Roughly 94% of the
 * programs that actually fail on mainnet publish neither an on-chain IDL nor a
 * verified build, so for those the only way to name an error code is for the
 * developer to supply the declarations themselves.
 *
 * Read-only on purpose. Ingesting an upload is a transport concern and lives in
 * the server; the engine only ever looks things up. Keeping the port this narrow
 * is what lets a filesystem store and an object store be interchangeable, and
 * what lets a test supply artifacts from memory.
 *
 * Note what is *not* here. A supplied binary is not consulted during diagnosis:
 * the question it answers — whether a local build is the one deployed — is about
 * current state and is settled once, when the artifact is stored, rather than on
 * every signature.
 */
export interface ArtifactStore {
  /**
   * The IDL document filed for a program, or `null` when none has been.
   *
   * Wrapped rather than returned bare because the document is arbitrary JSON and
   * could itself be `null`, which would otherwise be indistinguishable from
   * nothing being stored.
   *
   * Returned unparsed. What arrives is a JSON document somebody uploaded, and
   * the caller has to establish that it describes the program that actually ran
   * before reading anything out of it — an uploaded file is not evidence about
   * chain state the way an account at the Anchor-derived address is.
   */
  fetchIdl(programId: string): Promise<{ document: unknown } | null>;
  /**
   * The Rust source filed for a program, or `null` when none has been.
   *
   * Returned as raw text per file, unparsed, for the same reason `fetchIdl`
   * returns an unparsed document: what arrives is whatever somebody uploaded,
   * and the caller has to establish that it describes the program that ran
   * before reading a line number out of it.
   *
   * Optional so an existing store keeps compiling and simply never offers
   * source, which is the correct behaviour for one that has none.
   */
  fetchSource?(programId: string): Promise<SourceTree | null>;
}

/** One uploaded source file, with the path it was uploaded under. */
export interface SourceFile {
  /** Relative to the program's source root, always forward-slashed. */
  path: string;
  contents: string;
}

export interface SourceTree {
  files: SourceFile[];
}
