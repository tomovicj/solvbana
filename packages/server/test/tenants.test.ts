import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTenantStores } from '../src/artifacts/tenants.ts';

const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'solvbana-tenant-stores-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('createTenantStores', () => {
  it('refuses a tenant name that is not a valid tenant', async () => {
    const storeFor = createTenantStores(await directory());

    for (const bad of ['', '..', '../x', 'a/b', 'A', '-a', 'a'.repeat(65), 'a\0b']) {
      expect(() => storeFor(bad)).toThrow();
    }
    expect(storeFor('acme-1_x')).toBe(storeFor('acme-1_x'));
  });

  it('warns once about artifacts from the un-tenanted layout', async () => {
    const dir = await directory();
    await mkdir(join(dir, 'idl'));
    const warn = vi.fn();
    createTenantStores(dir, warn);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/un-tenanted.*not read.*re-uploaded/s);
  });

  it('says nothing for a clean directory', async () => {
    const dir = await directory();
    await mkdir(join(dir, 'tenants'));
    const warn = vi.fn();
    createTenantStores(dir, warn);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(warn).not.toHaveBeenCalled();
  });
});
