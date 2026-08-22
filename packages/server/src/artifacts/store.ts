import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { elfHash, parseAddress, type ArtifactStore } from '@solvbana/core';

/**
 * What was stored, and under what name.
 *
 * A binary's name is its own hash, which is the point: the deployed binary's
 * hash is a number this tool already computes, so a lookup by that hash is
 * itself a proof of identity rather than a claim needing one.
 */
export interface StoredBinary {
  hash: string;
  bytes: number;
}

/**
 * The store the upload route writes and the engine reads.
 *
 * The read half is `ArtifactStore`, which is all `@solvbana/core` ever sees.
 * Writing lives here because ingesting an upload is a transport concern, and
 * keeping it out of the port is what lets a test drive the engine from an
 * in-memory map.
 */
export interface WritableArtifactStore extends ArtifactStore {
  putIdl(programId: string, document: unknown): Promise<void>;
  /** Files the binary under its own hash and reports what that came to. */
  putBinary(bytes: Uint8Array): Promise<StoredBinary>;
  fetchBinary(hash: string): Promise<Uint8Array | null>;
}

/** Lowercase hex, 64 characters. Anything else never reaches the filesystem. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A store backed by a directory on disk.
 *
 * ```
 * <directory>/idl/<programId>.json
 * <directory>/bin/<sha256-of-trimmed-elf>.so
 * ```
 *
 * Both name components are validated before they are joined to a path, and
 * neither can contain a separator: a program id is proven to decode to 32 base58
 * bytes, and a hash is matched against a hex pattern. That is what keeps an
 * uploaded name from traversing out of the directory.
 *
 * Content addressing means nothing here is ever invalidated. Two uploads of the
 * same binary converge on one file, and a binary filed under a given hash stays
 * correct forever, because the hash is what it *is* rather than what it was
 * called.
 */
export function createFilesystemArtifactStore(directory: string): WritableArtifactStore {
  const idlDir = join(directory, 'idl');
  const binDir = join(directory, 'bin');

  const idlPath = (programId: string): string | null => {
    const parsed = parseAddress(programId);
    return parsed.ok ? join(idlDir, `${parsed.address}.json`) : null;
  };

  const binPath = (hash: string): string | null =>
    HASH_PATTERN.test(hash) ? join(binDir, `${hash}.so`) : null;

  /** A missing file is an empty store, not a failure. Anything else propagates. */
  const readOrNull = async (path: string): Promise<Buffer | null> => {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  return {
    async fetchIdl(programId) {
      const path = idlPath(programId);
      if (path === null) return null;

      const raw = await readOrNull(path);
      if (raw === null) return null;

      // A file this process wrote should always parse, but the directory is a
      // plain directory and someone may have put something else there. An
      // unreadable artifact is an absent one, never a crashed diagnosis.
      try {
        return { document: JSON.parse(raw.toString('utf8')) as unknown };
      } catch {
        return null;
      }
    },

    async fetchBinary(hash) {
      const path = binPath(hash);
      if (path === null) return null;

      const raw = await readOrNull(path);
      return raw === null ? null : Uint8Array.from(raw);
    },

    async putIdl(programId, document) {
      const path = idlPath(programId);
      if (path === null) throw new TypeError(`Not a program address: ${programId}`);

      await mkdir(idlDir, { recursive: true });
      await writeFile(path, JSON.stringify(document));
    },

    async putBinary(bytes) {
      // The same hash the deployment check computes, so the name a binary is
      // filed under is exactly the name a later lookup will ask for.
      const hash = elfHash(bytes);
      const path = binPath(hash);
      if (path === null) throw new TypeError(`Refusing to store under ${hash}.`);

      await mkdir(binDir, { recursive: true });
      await writeFile(path, bytes);

      return { hash, bytes: bytes.length };
    },
  };
}
