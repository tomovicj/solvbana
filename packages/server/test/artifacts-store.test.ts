import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elfHash } from '@solvbana/core';
import { createFilesystemArtifactStore } from '../src/artifacts/store.ts';

const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'solvbana-artifacts-'));
  directories.push(directory);
  return { directory, artifacts: createFilesystemArtifactStore(directory) };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('the filesystem artifact store', () => {
  it('round-trips an IDL under its program id', async () => {
    const { artifacts } = await store();
    await artifacts.putIdl(PROGRAM, { name: 'demo', instructions: [] });

    expect(await artifacts.fetchIdl(PROGRAM)).toEqual({
      document: { name: 'demo', instructions: [] },
    });
  });

  it('reports an absent artifact as absent rather than failing', async () => {
    const { artifacts } = await store();

    expect(await artifacts.fetchIdl(PROGRAM)).toBeNull();
    expect(await artifacts.fetchBinary('0'.repeat(64))).toBeNull();
  });

  it('files a binary under its own hash', async () => {
    // Content addressing is what makes a later lookup a proof: the deployed
    // binary's hash is a number this tool already computes, so asking the store
    // for that hash and getting a hit settles identity outright.
    const { artifacts, directory } = await store();
    const bytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);

    const stored = await artifacts.putBinary(bytes);

    expect(stored.hash).toBe(elfHash(bytes));
    expect(await readdir(join(directory, 'bin'))).toEqual([`${stored.hash}.so`]);
    expect(await artifacts.fetchBinary(stored.hash)).toEqual(bytes);
  });

  it('gives a binary the same hash with or without trailing zeros', async () => {
    // A ProgramData account is padded with zeros to leave room for a bigger
    // upgrade, and a locally built `.so` is not. Both sides go through the same
    // trim, so two copies of one program must not hash differently.
    const { artifacts } = await store();
    const bare = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 9]);
    const padded = Uint8Array.from([...bare, 0, 0, 0, 0, 0, 0]);

    const first = await artifacts.putBinary(bare);
    const second = await artifacts.putBinary(padded);

    expect(second.hash).toBe(first.hash);
  });

  it('refuses a program id that is not one, rather than making it a path', async () => {
    // The id arrives from a request and becomes a filename. Decoding it as 32
    // base58 bytes is what rules out a separator or an upward traversal, since
    // the alphabet contains neither `/` nor `.`.
    const { artifacts } = await store();

    await expect(artifacts.putIdl('../../etc/passwd', {})).rejects.toThrow(/program address/);
    expect(await artifacts.fetchIdl('../../etc/passwd')).toBeNull();
    expect(await artifacts.fetchBinary('../../etc/passwd')).toBeNull();
  });

  it('replaces a source tree rather than merging into it', async () => {
    // The engine proves a tree by its error enum, so a stale file from an
    // earlier revision would mix two revisions into one answer.
    const { artifacts } = await store();
    await artifacts.putSource(PROGRAM, [
      { path: 'a.rs', contents: 'a' },
      { path: 'b.rs', contents: 'b' },
    ]);

    const written = await artifacts.putSource(PROGRAM, [{ path: 'a.rs', contents: 'a2' }]);

    expect(written).toBe(1);
    expect(await artifacts.fetchSource(PROGRAM)).toEqual({
      files: [{ path: 'a.rs', contents: 'a2' }],
    });
  });

  it('keeps the previous tree when a later upload is refused', async () => {
    const { artifacts } = await store();
    await artifacts.putSource(PROGRAM, [
      { path: 'a.rs', contents: 'a' },
      { path: 'b.rs', contents: 'b' },
    ]);

    await expect(
      artifacts.putSource(PROGRAM, [
        { path: 'c.rs', contents: 'c' },
        { path: '../escape.rs', contents: 'x' },
      ]),
    ).rejects.toThrow(/Refusing/);

    const fetched = await artifacts.fetchSource(PROGRAM);
    expect(fetched?.files.map((f) => f.path).sort()).toEqual(['a.rs', 'b.rs']);
  });

  it('leaves no temporary files behind after a successful put', async () => {
    const { artifacts, directory } = await store();
    await artifacts.putIdl(PROGRAM, { name: 'demo' });
    await artifacts.putIdl(PROGRAM, { name: 'demo2' });
    await artifacts.putSource(PROGRAM, [{ path: 'a.rs', contents: 'a' }]);
    await artifacts.putSource(PROGRAM, [{ path: 'b.rs', contents: 'b' }]);

    expect(await readdir(join(directory, 'idl'))).toEqual([`${PROGRAM}.json`]);
    expect(await readdir(join(directory, 'src'))).toEqual([PROGRAM]);
  });

  it('round-trips nested source paths', async () => {
    const { artifacts } = await store();
    await artifacts.putSource(PROGRAM, [
      { path: 'src/lib.rs', contents: 'lib' },
      { path: 'src/instructions/buy.rs', contents: 'buy' },
    ]);

    const fetched = await artifacts.fetchSource(PROGRAM);
    expect(fetched?.files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'src/instructions/buy.rs', contents: 'buy' },
      { path: 'src/lib.rs', contents: 'lib' },
    ]);
  });

  it('treats an unreadable artifact as absent', async () => {
    // The directory is a plain directory and someone may put something else
    // there. That must degrade a diagnosis, never crash one.
    const { artifacts, directory } = await store();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'idl'), { recursive: true });
    await writeFile(join(directory, 'idl', `${PROGRAM}.json`), 'not json at all');

    expect(await artifacts.fetchIdl(PROGRAM)).toBeNull();
  });
});
