import type { AccountSource, ArtifactStore } from '../rpc/source.ts';
import { describeDeployment, isSlotAccurate, resolveDeployment } from './deployment.ts';
import { resolveIdl, type ResolvedIdl } from './idl.ts';
import { describeSuppliedIdl, suppliedIdl } from './local.ts';
import type { IdlSummary, Resolution } from './types.ts';
import { resolveVerifiedBuild, type VerifyOptions } from './verified.ts';

export interface ResolveOptions extends VerifyOptions {
  /**
   * Leading 8-byte discriminators, hex-encoded, of every instruction in the
   * transaction addressed to this program.
   *
   * This is what an uploaded IDL has to match before anything is read from it.
   * Passed in as data rather than resolved here so this tier keeps knowing
   * nothing about transactions.
   */
  observedDiscriminators?: readonly string[] | undefined;
  /**
   * Whether to spend the round trips that establish a verified build.
   *
   * Off by default because it costs an HTTP call and a full ProgramData read —
   * megabytes of mostly zero padding — and nothing before Phase 3 needs the
   * commit. The cascade's whole premise is that later tiers cost more, so the
   * expensive step waits until something will use it.
   */
  verifySource?: boolean;
}

/** Everything a resolution needs, plus the cache it shares across one process. */
export interface ResolveDeps {
  accounts: AccountSource;
  /**
   * Where uploaded artifacts are read from, when any are configured.
   *
   * Consulted only when the program publishes no IDL of its own. Roughly 94% of
   * the programs that fail on mainnet publish none, so for those this is the
   * only route to an error name — but an on-chain IDL always wins, because it is
   * evidence about chain state and an upload is not.
   */
  artifacts?: ArtifactStore | undefined;
}

/** The full IDL, kept beside the summary so refinement can read `errors[]` and discriminators. */
export interface ResolutionResult {
  resolution: Resolution;
  idl: ResolvedIdl | null;
}

function summarize(idl: ResolvedIdl): IdlSummary {
  return {
    address: idl.address,
    provenance: idl.provenance,
    programName: idl.programName,
    spec: idl.spec,
    declaredErrors: idl.errors.size,
    handlers: idl.handlers.length,
  };
}

/**
 * Cache keyed on a program and the deployment that was live for it.
 *
 * `lastDeploySlot` makes the key immutable by construction: a redeploy changes it,
 * so a stale entry cannot outlive the binary it describes. Process-local for now;
 * Phase 6 owns caching that survives a restart.
 */
const cache = new Map<string, ResolutionResult>();

/** Drop everything cached. Exists so tests do not leak resolutions into each other. */
export function clearResolutionCache(): void {
  cache.clear();
}

/**
 * Drop what is cached for one program.
 *
 * The cache key is built from chain state, which is immutable by construction —
 * a redeploy changes the deployment slot. An uploaded artifact is not: the store
 * can gain an IDL for a program between two diagnoses, and nothing in the key
 * reflects that. So whoever writes to the store has to say so, or the first
 * diagnosis after an upload keeps answering from before it.
 */
export function forgetProgram(programId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${programId}@`)) cache.delete(key);
  }
}

/**
 * Establish what is knowable about the program that failed.
 *
 * Ordered so the cheapest check is also the one that can stop everything else.
 * If the binary on chain is not the binary that ran, no amount of IDL or registry
 * work produces a statement about the right code, so the cascade halts there and
 * says why rather than resolving something that would read as an answer.
 */
export async function resolveProgram(
  programId: string,
  failingSlot: bigint,
  deps: ResolveDeps,
  options: ResolveOptions = {},
): Promise<ResolutionResult> {
  const notes: string[] = [];
  const deployment = await resolveDeployment(programId, failingSlot, deps.accounts);
  notes.push(describeDeployment(deployment));

  const cacheKey =
    deployment.kind === 'live'
      ? `${programId}@${String(deployment.lastDeploySlot)}:${String(options.verifySource ?? false)}:` +
        `${(options.observedDiscriminators ?? []).join(',')}`
      : null;

  const cached = cacheKey === null ? undefined : cache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (!isSlotAccurate(deployment)) {
    return {
      resolution: { programId, deployment, idl: null, verification: null, notes },
      idl: null,
    };
  }

  const idlOutcome = await resolveIdl(programId, deps.accounts);
  let idl = idlOutcome.kind === 'found' ? idlOutcome.idl : null;

  if (idlOutcome.kind === 'absent') {
    notes.push(
      `${programId} publishes no IDL at its Anchor-derived address (${idlOutcome.address}), so ` +
        'nothing establishes which framework, if any, defines the meaning of its error codes.',
    );
  } else if (idlOutcome.kind === 'unreadable') {
    notes.push(`An account exists at ${idlOutcome.address} but ${idlOutcome.reason}`);
  } else {
    notes.push(
      `${programId} publishes an Anchor IDL (${idl?.programName ?? '?'}, ` +
        `${idlOutcome.idl.spec === null ? 'pre-0.30 layout' : `spec ${idlOutcome.idl.spec}`}) ` +
        `declaring ${String(idlOutcome.idl.errors.size)} errors and ` +
        `${String(idlOutcome.idl.handlers.length)} instructions.`,
    );
  }

  // Only when the program publishes nothing of its own. An on-chain IDL is a
  // fact about chain state; an upload is a claim, and the claim does not get to
  // override the fact.
  if (idl === null && deps.artifacts !== undefined) {
    const outcome = await suppliedIdl(
      deps.artifacts,
      programId,
      options.observedDiscriminators ?? [],
    );
    const note = describeSuppliedIdl(outcome, programId);
    if (note !== null) notes.push(note);
    if (outcome.kind === 'found') idl = outcome.idl;
  }

  const verification =
    options.verifySource === true
      ? await resolveVerifiedBuild(programId, deployment, deps.accounts, options)
      : null;

  if (verification !== null && verification.kind !== 'verified') notes.push(verification.reason);
  if (verification?.kind === 'verified') {
    notes.push(
      `The deployed binary hashes to ${verification.build.hash}, matching the verified-build ` +
        `entry for ${verification.build.repoUrl} at commit ${verification.build.commit}.`,
    );
  }

  const result: ResolutionResult = {
    resolution: {
      programId,
      deployment,
      idl: idl === null ? null : summarize(idl),
      verification,
      notes,
    },
    idl,
  };

  if (cacheKey !== null) cache.set(cacheKey, result);
  return result;
}
