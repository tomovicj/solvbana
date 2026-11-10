import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { TENANT_PATTERN } from '../config.ts';
import { createFilesystemArtifactStore, type WritableArtifactStore } from './store.ts';

/**
 * One filesystem store per tenant, created on first use and then reused.
 *
 * ```
 * <directory>/tenants/<tenant>/{idl,src,bin}
 * ```
 *
 * The tenant name was validated at configuration time against
 * `TENANT_PATTERN`, and is checked again here before it is joined to a path, so
 * a caller that skipped configuration still cannot traverse out of `tenants/`.
 *
 * Anything at the earlier un-tenanted layout (`<directory>/idl`, `src`, `bin`)
 * is deliberately no longer read: it was filed globally, so serving it to
 * whichever tenant asks first would hand one user's upload to another. It is
 * neither migrated nor deleted.
 */
export function createTenantStores(
  directory: string,
  warn: (message: string) => void = () => undefined,
): (tenant: string) => WritableArtifactStore {
  warnAboutUntenantedLayout(directory, warn);
  const stores = new Map<string, WritableArtifactStore>();
  return (tenant) => {
    if (!TENANT_PATTERN.test(tenant)) throw new TypeError('Not a valid tenant name.');
    let store = stores.get(tenant);
    if (store === undefined) {
      store = createFilesystemArtifactStore(join(directory, 'tenants', tenant));
      stores.set(tenant, store);
    }
    return store;
  };
}

/**
 * Fire-and-forget: say once, at startup, that earlier uploads are not being read.
 * Never throws and never delays startup; a directory that cannot be inspected
 * simply produces no warning.
 */
function warnAboutUntenantedLayout(directory: string, warn: (message: string) => void): void {
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  void Promise.all([exists(join(directory, 'idl')), exists(join(directory, 'src'))])
    .then(([idl, src]) => {
      if (idl || src) {
        warn(
          `${directory} holds artifacts from the earlier un-tenanted layout (${[idl ? 'idl' : '', src ? 'src' : ''].filter((x) => x !== '').join(', ')}). ` +
            'They are not read and must be re-uploaded under an API key.',
        );
      }
    })
    .catch(() => undefined);
}
