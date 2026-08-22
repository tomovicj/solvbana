import type { AccountSource } from '../rpc/source.ts';
import { PROGRAM_DATA_HEADER_SIZE, type Deployment } from './deployment.ts';
import { elfHash } from './hash.ts';

export const DEFAULT_VERIFY_REGISTRY_URL = 'https://verify.osec.io';

export interface VerifiedBuild {
  repoUrl: string;
  commit: string;
  /** The hash both the registry and this tool computed, which had to agree to get here. */
  hash: string;
  lastVerifiedAt: string | null;
}

/**
 * A registry entry whose rebuild produced exactly the deployed bytes, but which
 * the registry itself does not currently vouch for.
 *
 * Reported rather than trusted. `status-all` does not say *why* `is_verified` is
 * false, and the two possibilities are not equivalent: the entry may simply be
 * stale, its recorded `on_chain_hash` predating the current deployment, or it may
 * have been withdrawn for a reason the API does not expose. Promoting it would
 * risk naming a commit the registry deliberately stopped standing behind, which
 * is the "looks right, describes different code" failure this project is built
 * around avoiding. Naming it here lets the reader see the commit and see exactly
 * why it did not qualify.
 */
export interface BuildCandidate {
  repoUrl: string;
  commit: string;
  /** The hash this tool computed, which this entry's rebuild also produced. */
  hash: string;
  /** The registry's own recorded on-chain hash — why its verified flag disagrees. */
  registryOnChainHash: string | null;
  lastVerifiedAt: string | null;
}

export type VerificationOutcome =
  | { kind: 'verified'; build: VerifiedBuild }
  /**
   * No entry this tool is willing to trust, with the reason.
   *
   * `candidate` is set when some entry's rebuild does hash to the deployed
   * bytes even though the registry does not mark it verified.
   */
  | { kind: 'unverified'; reason: string; candidate: BuildCandidate | null }
  /** The deployment is not the one that ran, so the registry's claims are about other bytes. */
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'unavailable'; reason: string };

/**
 * The hash a verified-build registry keys on, read out of a ProgramData account.
 *
 * The ELF starts after the 45-byte loader header; {@link elfHash} does the rest,
 * including the trailing-zero trim that the padding makes necessary.
 */
export function programHash(programDataBytes: Uint8Array): string {
  return elfHash(programDataBytes.subarray(PROGRAM_DATA_HEADER_SIZE));
}

interface RegistryEntry {
  is_verified?: unknown;
  on_chain_hash?: unknown;
  executable_hash?: unknown;
  repo_url?: unknown;
  commit?: unknown;
  last_verified_at?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pick the registry entry worth believing, if any.
 *
 * `status-all` returns every submission for a program, and mainnet really does
 * return conflicting ones: Whirlpool has a verified entry alongside an unverified
 * entry pointing at the same repository whose `executable_hash` differs from what
 * is deployed. Taking the first would report a repo that does not build to the
 * running binary.
 *
 * Two conditions, both necessary. `is_verified` is the registry's own judgement.
 * `executable_hash === on_chain_hash` is the substance behind it: the commit was
 * rebuilt and produced exactly the bytes that are deployed.
 *
 * Both are the registry's view of chain state, refreshed on its own schedule,
 * and this tool reads the chain more accurately than that. The gate is kept
 * anyway: an entry failing it is not necessarily merely stale, and the API does
 * not distinguish the cases. {@link BuildCandidate} carries the near miss instead.
 */
export function selectTrustworthyEntry(entries: readonly RegistryEntry[]): RegistryEntry | null {
  for (const entry of entries) {
    if (entry.is_verified !== true) continue;

    const onChain = asString(entry.on_chain_hash);
    const executable = asString(entry.executable_hash);
    if (onChain === null || onChain !== executable) continue;
    if (asString(entry.repo_url) === null || asString(entry.commit) === null) continue;

    return entry;
  }

  return null;
}

async function queryRegistry(
  registryUrl: string,
  programId: string,
): Promise<RegistryEntry[] | { error: string }> {
  try {
    const response = await fetch(`${registryUrl.replace(/\/$/, '')}/status-all/${programId}`, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      return { error: `The verified-build registry answered ${String(response.status)}.` };
    }

    const body: unknown = await response.json();
    return Array.isArray(body) ? (body as RegistryEntry[]) : [];
  } catch (error) {
    return {
      error: `The verified-build registry could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface VerifyOptions {
  /** An empty string disables registry lookups, which is reported rather than done silently. */
  registryUrl?: string | undefined;
}

/**
 * Establish the repository and commit that produced the deployed binary.
 *
 * The deployment check gates this entirely. A registry entry describes whatever
 * is deployed *now*, so on an upgraded or closed program it is a statement about
 * different bytes than the ones that ran — using it would attach a real, correct
 * commit to the wrong transaction, which is worse than attaching nothing.
 *
 * The registry's own `on_chain_hash` is not taken on trust either. The bytes are
 * fetched and hashed here, and a disagreement is reported rather than resolved in
 * the registry's favour: the whole point of the hash is that this tool checked it.
 */
export async function resolveVerifiedBuild(
  programId: string,
  deployment: Deployment,
  source: AccountSource,
  options: VerifyOptions = {},
): Promise<VerificationOutcome> {
  if (deployment.kind !== 'live') {
    return {
      kind: 'not-applicable',
      reason:
        deployment.kind === 'immutable'
          ? 'The program is owned by a non-upgradeable loader, so it has no ProgramData account ' +
            'to hash and no verified-build entry can be checked against it.'
          : 'The binary on chain is not the one that ran, so any verified-build entry describes ' +
            'different bytes and is not consulted.',
    };
  }

  const registryUrl = options.registryUrl ?? DEFAULT_VERIFY_REGISTRY_URL;
  if (registryUrl === '') {
    return {
      kind: 'unavailable',
      reason:
        'Verified-build lookups are disabled, so no repository or commit is resolved. Set ' +
        'SOLVBANA_VERIFY_REGISTRY_URL to enable them.',
    };
  }

  const entries = await queryRegistry(registryUrl, programId);
  if (!Array.isArray(entries)) return { kind: 'unavailable', reason: entries.error };

  const entry = selectTrustworthyEntry(entries);

  if (entry === null && entries.length === 0) {
    return {
      kind: 'unverified',
      candidate: null,
      reason:
        `${programId} has no entry in the verified-build registry, so no source repository is ` +
        'known for it. Line numbers are out of reach for this program.',
    };
  }

  // The bytes are needed either way now: to confirm a trusted entry, or to see
  // whether a rejected one nonetheless rebuilds to what is deployed.
  const account = await source.fetchAccount(deployment.programData);
  if (account === null) {
    return {
      kind: 'unavailable',
      reason: `The ProgramData account ${deployment.programData} could not be read to hash it.`,
    };
  }

  const computed = programHash(Uint8Array.from(Buffer.from(account.data, 'base64')));

  if (entry === null) {
    const near = entries.find(
      (candidate) =>
        asString(candidate.executable_hash) === computed &&
        asString(candidate.repo_url) !== null &&
        asString(candidate.commit) !== null,
    );

    return {
      kind: 'unverified',
      candidate:
        near === undefined
          ? null
          : {
              repoUrl: asString(near.repo_url) ?? '',
              commit: asString(near.commit) ?? '',
              hash: computed,
              registryOnChainHash: asString(near.on_chain_hash),
              lastVerifiedAt: asString(near.last_verified_at),
            },
      reason:
        near === undefined
          ? `${programId} has registry entries, but none is marked verified and none rebuilds to ` +
            `the deployed binary (${computed}). The published source does not build to what is ` +
            'running.'
          : `${programId} has a registry entry for ${asString(near.repo_url) ?? ''} at commit ` +
            `${asString(near.commit) ?? ''} whose rebuild hashes to ${computed}, which is exactly ` +
            'the binary that ran. The registry does not currently mark it verified — its own ' +
            `recorded on-chain hash is ${String(asString(near.on_chain_hash))} — so it is ` +
            'reported rather than trusted, and nothing is derived from that source.',
    };
  }

  // Compared against `executable_hash`, not `on_chain_hash`: the former is the
  // claim that carries meaning, that this repository at this commit rebuilds to
  // these bytes. The latter is the registry re-reading a chain this tool has
  // already read, slot-accurately.
  const rebuilt = asString(entry.executable_hash);

  if (computed !== rebuilt) {
    return {
      kind: 'unverified',
      candidate: null,
      reason:
        `The registry reports that ${programId} rebuilds to ${String(rebuilt)}, but the deployed ` +
        `ProgramData account hashes to ${computed}. The entry describes a different binary, so ` +
        'its repository and commit are not used.',
    };
  }

  return {
    kind: 'verified',
    build: {
      repoUrl: asString(entry.repo_url) ?? '',
      commit: asString(entry.commit) ?? '',
      hash: computed,
      lastVerifiedAt: asString(entry.last_verified_at),
    },
  };
}
