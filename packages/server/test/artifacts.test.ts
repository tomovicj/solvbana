import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeBase58, elfHash, type AccountSnapshot, type AccountSource } from '@solvbana/core';
import { createFilesystemArtifactStore } from '../src/artifacts/store.ts';
import { testApp } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string };
}

interface UploadBody {
  programId: string;
  idl: { stored: true; programName: string; declaredErrors: number; handlers: number } | null;
  binary: {
    stored: true;
    hash: string;
    bytes: number;
    deployed: { kind: string; deployedHash?: string; reason?: string };
  } | null;
  notes: string[];
}

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PROGRAM_DATA = 'CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function appWithStore(accounts?: AccountSource) {
  const directory = await mkdtemp(join(tmpdir(), 'solvbana-route-'));
  directories.push(directory);
  return testApp({ artifacts: createFilesystemArtifactStore(directory), accounts });
}

const IDL_030 = {
  address: PROGRAM,
  metadata: { name: 'demo', spec: '0.1.0' },
  instructions: [{ name: 'sell', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [], args: [] }],
  errors: [{ code: 6000, name: 'Slipped', msg: 'Price moved.' }],
};

/** The pre-0.30 layout: a top-level name and no `address` of its own. */
const IDL_LEGACY = {
  name: 'legacy_demo',
  instructions: [{ name: 'withdraw', accounts: [], args: [] }],
  errors: [{ code: 6000, name: 'Nope', msg: 'No.' }],
};

describe('POST /artifacts', () => {
  it('refuses uploads when no store is configured', async () => {
    const response = await testApp().inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_030 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorBody>().error.code).toBe('artifacts_disabled');
  });

  it('rejects a request carrying neither artifact', async () => {
    const app = await appWithStore();
    const response = await app.inject({ method: 'POST', url: '/artifacts', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('empty_upload');
  });

  it('takes the program id from a 0.30+ IDL, which declares its own', async () => {
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_030 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UploadBody>()).toMatchObject({
      programId: PROGRAM,
      idl: { stored: true, programName: 'demo', declaredErrors: 1, handlers: 1 },
      binary: null,
    });
  });

  it('requires an explicit program id for a pre-0.30 IDL', async () => {
    // The older layout omits `address` entirely, so there is nothing to read it
    // from and guessing would file the document under the wrong program.
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_LEGACY },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('unidentified_program');

    const named = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_LEGACY, programId: PROGRAM },
    });
    expect(named.statusCode).toBe(200);
    expect(named.json<UploadBody>().idl?.programName).toBe('legacy_demo');
  });

  it('refuses a disagreement between the IDL and the stated id', async () => {
    // One of the two is wrong. Filing under either would serve another
    // program's error names later, so neither is chosen.
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_030, programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.message).toMatch(/One of them is wrong/);
  });

  it('rejects a program id that is not an address', async () => {
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: IDL_LEGACY, programId: '../../etc/passwd' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('unidentified_program');
  });

  it('rejects a document that cannot be read as an IDL', async () => {
    // Caught at upload rather than silently failing every later diagnosis.
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { idl: { nothing: true }, programId: PROGRAM },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('unreadable_idl');
  });

  it('says the uploaded binary is the one deployed when it hashes the same', async () => {
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 11, 22, 33]);
    const app = await appWithStore(chainWith(elf));

    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { programId: PROGRAM, binary: Buffer.from(elf).toString('base64') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UploadBody>().binary).toMatchObject({
      stored: true,
      hash: elfHash(elf),
      deployed: { kind: 'match' },
    });
  });

  it('reports both hashes when the build is not what is deployed', async () => {
    // "They differ" is not actionable on its own; the deployed hash is what
    // lets a developer find which build is actually running.
    const app = await appWithStore(chainWith(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 99])));

    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { programId: PROGRAM, binary: Buffer.from([1, 2, 3]).toString('base64') },
    });

    const { deployed } = response.json<UploadBody>().binary!;
    expect(deployed.kind).toBe('mismatch');
    expect(deployed.deployedHash).toHaveLength(64);
  });

  it('stores the binary but says why it could not be compared when the chain is unreadable', async () => {
    const app = await appWithStore();
    const response = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: { programId: PROGRAM, binary: Buffer.from([1, 2, 3]).toString('base64') },
    });

    expect(response.json<UploadBody>().binary).toMatchObject({
      stored: true,
      deployed: { kind: 'unknown' },
    });
  });
});

/**
 * An account source serving a program that owns the given ELF.
 *
 * The ProgramData account is built the way the chain holds one — a 45-byte
 * loader header, then the ELF, then the zero padding reserved for a larger
 * future upgrade — so the route's hashing path sees a realistic shape.
 */
function chainWith(elf: Uint8Array): AccountSource {
  const programAccount = new Uint8Array(36);
  programAccount.set([2, 0, 0, 0], 0);
  programAccount.set(decodeBase58(PROGRAM_DATA)!, 4);

  const programData = new Uint8Array(45 + elf.length + 512);
  programData.set([3, 0, 0, 0], 0);
  programData.set(elf, 45);

  const snapshot = (address: string, data: Uint8Array, owner: string): AccountSnapshot => ({
    address,
    owner,
    executable: false,
    data: Buffer.from(data).toString('base64'),
    size: data.length,
    readAtSlot: 1n,
  });

  const accounts = new Map<string, AccountSnapshot>([
    [PROGRAM, snapshot(PROGRAM, programAccount, 'BPFLoaderUpgradeab1e11111111111111111111111')],
    [
      PROGRAM_DATA,
      snapshot(PROGRAM_DATA, programData, 'BPFLoaderUpgradeab1e11111111111111111111111'),
    ],
  ]);

  return {
    fetchAccount: (address) => Promise.resolve(accounts.get(address) ?? null),
    fetchAccountPrefix: (address, length) => {
      const account = accounts.get(address);
      if (account === undefined) return Promise.resolve(null);
      const bytes = Buffer.from(account.data, 'base64').subarray(0, length);
      return Promise.resolve({ ...account, data: bytes.toString('base64') });
    },
  };
}
