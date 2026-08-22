import {
  currentDeployment,
  elfHash,
  parseAddress,
  parseIdlDocument,
  type AccountSource,
} from '@solvbana/core';
import type { App } from '../app.ts';
import type { WritableArtifactStore } from '../artifacts/store.ts';
import { ArtifactsBody, ArtifactsResponse } from '../schemas/artifacts.ts';
import { ErrorResponse, errorBody } from '../schemas/error.ts';

/** The verdict shape the response declares, named so the helper below can return it. */
type DeployedComparison = NonNullable<ArtifactsResponse['binary']>['deployed'];

/** The `address` an Anchor 0.30+ IDL carries for itself, if this document is one. */
function declaredAddress(document: unknown): string | null {
  if (typeof document !== 'object' || document === null) return null;
  const address = (document as Record<string, unknown>)['address'];
  return typeof address === 'string' && address.length > 0 ? address : null;
}

type Identified = { ok: true; programId: string } | { ok: false; message: string };

/**
 * Decide which program an upload is about.
 *
 * Every 0.30+ IDL in the corpus declares its own `address` and every pre-0.30
 * one omits it, so the modern layout needs nothing from the caller and the older
 * one needs an explicit id. When both are present and disagree, that is refused
 * rather than resolved in either direction: one of the two is wrong, and filing
 * the document under a guess would serve another program's error names later.
 */
function identify(body: ArtifactsBody): Identified {
  const declared = body.idl === undefined ? null : declaredAddress(body.idl);
  const stated = body.programId ?? null;

  if (declared !== null && stated !== null && declared !== stated) {
    return {
      ok: false,
      message:
        `The IDL declares address ${declared} but the request states ${stated}. One of them is ` +
        'wrong, and filing the document under either would be a guess.',
    };
  }

  const chosen = stated ?? declared;
  if (chosen === null) {
    return {
      ok: false,
      message:
        'No program id. Anchor 0.30 and later record it in the IDL itself; for an earlier IDL, ' +
        'or for a binary uploaded on its own, send `programId`.',
    };
  }

  const parsed = parseAddress(chosen);
  return parsed.ok
    ? { ok: true, programId: parsed.address }
    : { ok: false, message: parsed.message };
}

export function registerArtifactRoutes(
  app: App,
  artifacts: WritableArtifactStore | undefined,
  accounts: AccountSource | undefined,
): void {
  app.post(
    '/artifacts',
    {
      schema: {
        body: ArtifactsBody,
        response: { 200: ArtifactsResponse, 400: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      if (artifacts === undefined) {
        return reply
          .code(503)
          .send(
            errorBody(
              'artifacts_disabled',
              'No artifact store is configured. Set SOLVBANA_ARTIFACT_DIR to accept uploads.',
            ),
          );
      }

      const body = request.body;
      if (body.idl === undefined && body.binary === undefined) {
        return reply
          .code(400)
          .send(errorBody('empty_upload', 'Send an `idl`, a `binary`, or both.'));
      }

      const identified = identify(body);
      if (!identified.ok) {
        return reply.code(400).send(errorBody('unidentified_program', identified.message));
      }
      const { programId } = identified;
      const notes: string[] = [];

      let idl: ArtifactsResponse['idl'] = null;
      if (body.idl !== undefined) {
        // Parsed before it is stored, so a document that cannot be read is
        // rejected at upload rather than silently failing every diagnosis later.
        const parsed = parseIdlDocument(body.idl, programId);
        if (parsed === null) {
          return reply
            .code(400)
            .send(
              errorBody(
                'unreadable_idl',
                'That document could not be read as an Anchor IDL: it declares no program name.',
              ),
            );
        }

        await artifacts.putIdl(programId, body.idl);
        idl = {
          stored: true,
          programName: parsed.programName,
          declaredErrors: parsed.errors.size,
          handlers: parsed.handlers.length,
        };
        notes.push(
          'A supplied IDL names error codes the program itself declares, but it is not evidence ' +
            'the program is Anchor the way an on-chain IDL is, so it never unlocks Anchor’s ' +
            'built-in error table. It is used only when its discriminators match the failing ' +
            'instruction.',
        );
      }

      let binary: ArtifactsResponse['binary'] = null;
      if (body.binary !== undefined) {
        const bytes = Uint8Array.from(Buffer.from(body.binary, 'base64'));
        if (bytes.length === 0) {
          return reply
            .code(400)
            .send(errorBody('unreadable_binary', '`binary` did not decode to any bytes.'));
        }

        const stored = await artifacts.putBinary(bytes);
        binary = {
          stored: true,
          hash: stored.hash,
          bytes: stored.bytes,
          deployed: await compareWithChain(programId, stored.hash, accounts),
        };
      }

      return { programId, idl, binary, notes };
    },
  );
}

/**
 * Whether the uploaded binary is what is deployed for this program right now.
 *
 * Deliberately a statement about current state, not about any transaction: there
 * is no failing slot here to compare against. What it establishes is the thing a
 * developer actually wants to know before reading any further — whether the
 * build in front of them is the one running.
 */
async function compareWithChain(
  programId: string,
  hash: string,
  accounts: AccountSource | undefined,
): Promise<DeployedComparison> {
  if (accounts === undefined) {
    return {
      kind: 'unknown',
      reason: 'No account source is configured, so the chain was not read.',
    };
  }

  const deployment = await currentDeployment(programId, accounts);
  if (deployment.kind !== 'live') {
    return {
      kind: 'unknown',
      reason:
        deployment.kind === 'immutable'
          ? 'The program is owned by a non-upgradeable loader and has no ProgramData account to hash.'
          : deployment.kind === 'closed'
            ? `The ProgramData account ${deployment.programData} no longer exists.`
            : deployment.reason,
    };
  }

  const account = await accounts.fetchAccount(deployment.programData);
  if (account === null) {
    return {
      kind: 'unknown',
      reason: `The ProgramData account ${deployment.programData} could not be read.`,
    };
  }

  // Both sides go through the same trim, so identical programs hash identically
  // whether they arrived as a padded ProgramData account or a bare `.so`.
  const deployedHash = elfHash(Uint8Array.from(Buffer.from(account.data, 'base64')).subarray(45));

  return deployedHash === hash ? { kind: 'match' } : { kind: 'mismatch', deployedHash };
}
