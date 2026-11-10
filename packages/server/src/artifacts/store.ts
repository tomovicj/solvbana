import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  elfHash,
  parseAddress,
  type ArtifactStore,
  type SourceFile,
  type SourceTree,
} from '@solvbana/core';

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
/** One program an artifact store holds something for. */
export interface StoredProgram {
  programId: string;
  idl: boolean;
  sourceFiles: number;
}

export interface WritableArtifactStore extends ArtifactStore {
  /** Always present here, though optional on the read port. */
  fetchSource(programId: string): Promise<SourceTree | null>;
  putIdl(programId: string, document: unknown): Promise<void>;
  /** Files the binary under its own hash and reports what that came to. */
  putBinary(bytes: Uint8Array): Promise<StoredBinary>;
  fetchBinary(hash: string): Promise<Uint8Array | null>;
  /** Replaces whatever source was filed for this program. */
  putSource(programId: string, files: readonly SourceFile[]): Promise<number>;
  /** Every program this store holds an IDL or source for, ordered by program id. */
  listPrograms(): Promise<StoredProgram[]>;
}

/**
 * A path that may be joined onto the source directory.
 *
 * The same stance the program id and hash validation already take: a name is
 * proven safe before it is joined to a path, never sanitised afterwards. Only
 * relative, forward-slashed `.rs` files, with no traversal segment and no
 * leading slash or drive letter — anything else never reaches the filesystem.
 */
export function isSafeSourcePath(path: string): boolean {
  if (!path.endsWith('.rs') || path.length > 400) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Paths in one upload that cannot be stored as files, even though each is safe.
 *
 * A path with a non-final segment ending `.rs` would create a directory named
 * like a source file, and a path that is a directory prefix of another in the
 * same upload cannot be both a file and a directory.
 */
export function conflictingSourcePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const segments = path.split('/');
    if (segments.slice(0, -1).some((segment) => segment.endsWith('.rs'))) return true;
    return paths.some((other) => other.startsWith(`${path}/`));
  });
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
  const srcDir = join(directory, 'src');

  const sourceRoot = (programId: string): string | null => {
    const parsed = parseAddress(programId);
    return parsed.ok ? join(srcDir, parsed.address) : null;
  };

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

  /** Entry names in a directory; a directory never written to is an empty one. */
  const namesIn = async (dir: string): Promise<string[]> => {
    try {
      return await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  /** Regular files under a tree, as forward-slashed relative paths. Directories are skipped. */
  const sourceFileNames = async (root: string): Promise<string[]> => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(relative(root, entry.parentPath), entry.name).split('\\').join('/'))
      .filter(isSafeSourcePath);
  };

  /**
   * How many source files are filed for a program, from the directory listing
   * alone. Listing programs must not read every file of every tree.
   */
  const countSourceFiles = async (programId: string): Promise<number> => {
    const root = sourceRoot(programId);
    if (root === null) return 0;
    try {
      return (await sourceFileNames(root)).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  };

  /** Uploads for one program run one at a time within this process. */
  const sourceQueues = new Map<string, Promise<unknown>>();
  const serialized = <T>(programId: string, task: () => Promise<T>): Promise<T> => {
    const run = (sourceQueues.get(programId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    sourceQueues.set(programId, tail);
    // Cleaned up once idle, so the map holds only programs with an upload in flight.
    void tail.then(() => {
      if (sourceQueues.get(programId) === tail) sourceQueues.delete(programId);
    });
    return run;
  };

  return {
    async listPrograms() {
      const ids = new Set<string>();
      // `parseAddress` also drops the `.new-*`, `.old-*` and `.tmp-*` temporaries:
      // a leading dot is not base58.
      for (const name of await namesIn(idlDir)) {
        const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
        if (parseAddress(id).ok) ids.add(id);
      }
      for (const name of await namesIn(srcDir)) {
        if (parseAddress(name).ok) ids.add(name);
      }

      const programs: StoredProgram[] = [];
      for (const programId of [...ids].sort()) {
        const idl = (await this.fetchIdl(programId)) !== null;
        programs.push({ programId, idl, sourceFiles: await countSourceFiles(programId) });
      }
      return programs.filter((p) => p.idl || p.sourceFiles > 0);
    },

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

    async fetchSource(programId) {
      const root = sourceRoot(programId);
      if (root === null) return null;

      // One pass over a listing. `null` means the tree changed underneath us: the
      // root or a listed file vanished, which is what a concurrent replacement
      // looks like from here.
      const attempt = async (): Promise<SourceFile[] | null> => {
        let names: string[];
        let before: number;
        try {
          // A replacement moves a different directory into `root`, so its inode
          // changing between here and the end of the reads is how a swap that
          // happened mid-read is noticed, rather than mixing files of two trees.
          before = (await stat(root)).ino;
          names = await sourceFileNames(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }

        const files: SourceFile[] = [];
        for (const name of names) {
          const path = name;
          const raw = await readOrNull(join(root, path));
          if (raw === null) return null;
          files.push({ path, contents: raw.toString('utf8') });
        }
        try {
          if ((await stat(root)).ino !== before) return null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        return files;
      };

      // Retried once, then reported as absent. A tree is returned only if every
      // file in one listing was read; a mixture of old and new files never is.
      const files = (await attempt()) ?? (await attempt());
      return files === null || files.length === 0 ? null : { files };
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
      // Written beside the target and renamed over it, so a concurrent read
      // sees the old document or the new one, never a truncated file.
      const temporary = join(idlDir, `.tmp-${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(document));
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async putBinary(bytes) {
      // The same hash the deployment check computes, so the name a binary is
      // filed under is exactly the name a later lookup will ask for.
      const hash = elfHash(bytes);
      const path = binPath(hash);
      if (path === null) throw new TypeError(`Refusing to store under ${hash}.`);

      await mkdir(binDir, { recursive: true });
      // Beside the target and renamed over it, like an IDL: a concurrent reader
      // never sees a truncated binary under a name that claims to be its hash.
      const temporary = join(binDir, `.tmp-${randomUUID()}`);
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }

      return { hash, bytes: bytes.length };
    },

    putSource(programId, files) {
      return serialized(programId, () => replaceSource(programId, files));
    },
  };

  async function replaceSource(programId: string, files: readonly SourceFile[]): Promise<number> {
    const root = sourceRoot(programId);
    if (root === null) throw new TypeError(`Not a program address: ${programId}`);

    // Every path is proven before anything touches the disk, so a refused
    // upload cannot leave a partial tree of any kind behind.
    for (const file of files) {
      if (!isSafeSourcePath(file.path)) {
        throw new TypeError(`Refusing to store source under ${file.path}.`);
      }
    }
    const conflicts = conflictingSourcePaths(files.map((file) => file.path));
    if (conflicts.length > 0) {
      throw new TypeError(`Refusing to store source under ${conflicts[0] ?? ''}.`);
    }

    // The new tree is built beside the old one and swapped in by two renames,
    // so a reader never sees a half-written tree and a failed upload keeps the
    // previous one. Between the renames a reader sees no tree at all, and
    // `fetchSource` treats that (or files vanishing mid-listing) as a reason to
    // retry once, then as absent. Uploads for one program are serialized within
    // this process; two processes sharing a directory are not coordinated.
    // A leading dot cannot collide with a program id: base58 has none.
    await mkdir(srcDir, { recursive: true });
    const fresh = join(srcDir, `.new-${randomUUID()}`);
    const stale = join(srcDir, `.old-${randomUUID()}`);

    try {
      await mkdir(fresh);
      for (const file of files) {
        const path = join(fresh, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.contents);
      }

      let hadPrevious = true;
      try {
        await rename(root, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hadPrevious = false;
      }

      try {
        await rename(fresh, root);
      } catch (error) {
        // Put the previous tree back rather than leave the program with none.
        if (hadPrevious) await rename(stale, root).catch(() => undefined);
        throw error;
      }

      if (hadPrevious) await rm(stale, { recursive: true, force: true });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }

    return files.length;
  }
}
